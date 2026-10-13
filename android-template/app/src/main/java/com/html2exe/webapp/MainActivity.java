package __PACKAGE_NAME__;

import android.Manifest;
import android.animation.AnimatorSet;
import android.animation.ObjectAnimator;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Message;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.animation.DecelerateInterpolator;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.URLUtil;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

public class MainActivity extends Activity {
    private WebView web;
    private String host;
    private FrameLayout splash;
    private LinearLayout splashContent;
    private Runnable dismissSplash;
    private AnimatorSet splashAnimation;

    // WebView renders none of these, so navigating to one just shows a blank
    // page. Hand them to DownloadManager instead.
    private static final String[] DOWNLOAD_EXTS = {
        ".pdf", ".zip", ".rar", ".7z", ".apk", ".doc", ".docx", ".xls", ".xlsx",
        ".ppt", ".pptx", ".csv", ".mp3", ".mp4", ".epub"
    };

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        String target = getString(R.string.target_url);
        host = Uri.parse(target).getHost();

        // DownloadManager writes to the public Downloads dir, which needs this
        // permission on API <= 28 only (scoped storage handles it after that).
        if (Build.VERSION.SDK_INT >= 23 && Build.VERSION.SDK_INT <= 28
                && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                   != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, 1);
        }

        web = new WebView(this);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        // Without this, target="_blank" and window.open() links do nothing at all.
        web.getSettings().setSupportMultipleWindows(true);
        // Harden the WebView: no local file/content access from web content.
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setAllowContentAccess(false);
        web.getSettings().setAllowFileAccessFromFileURLs(false);
        web.getSettings().setAllowUniversalAccessFromFileURLs(false);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme();
                String reqHost = uri.getHost();
                boolean sameHost = host != null && host.equalsIgnoreCase(reqHost);
                boolean isWeb = "https".equals(scheme) || "http".equals(scheme);

                // A file link (e.g. an inline-served PDF) would render blank —
                // download it rather than navigating into a dead page.
                if (isWeb && sameHost && looksLikeFile(uri)) {
                    startDownload(uri.toString(), null, null, null);
                    return true;
                }
                if (isWeb && sameHost) {
                    return false; // let the WebView load it
                }
                // Everything else (other domains, tel:, mailto:, intent:) goes
                // to the system so it can't be abused inside our WebView.
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {}
                return true;
            }
        });

        // Popups / new tabs: load them in the main WebView instead of dropping them.
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog,
                                          boolean isUserGesture, Message resultMsg) {
                WebView proxy = new WebView(view.getContext());
                proxy.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                        web.loadUrl(req.getUrl().toString());
                        return true;
                    }
                });
                ((WebView.WebViewTransport) resultMsg.obj).setWebView(proxy);
                resultMsg.sendToTarget();
                return true;
            }
        });

        // Fires when the server responds with Content-Disposition: attachment.
        web.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent,
                                        String contentDisposition, String mimeType, long size) {
                startDownload(url, userAgent, contentDisposition, mimeType);
            }
        });

        FrameLayout root = new FrameLayout(this);
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);
        if (state == null && getResources().getBoolean(R.bool.splash_enabled)) {
            showSplash(root);
        }
        web.loadUrl(target);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void showSplash(FrameLayout root) {
        splash = new FrameLayout(this);
        splash.setBackgroundColor(getResources().getColor(R.color.splash_background));
        splash.setClickable(true);
        splash.setPadding(dp(24), dp(24), dp(24), dp(24));
        splashContent = new LinearLayout(this);
        splashContent.setOrientation(LinearLayout.VERTICAL);
        splashContent.setGravity(Gravity.CENTER);
        FrameLayout.LayoutParams contentParams = new FrameLayout.LayoutParams(-1, -2, Gravity.CENTER);
        splash.addView(splashContent, contentParams);
        int logo = getResources().getIdentifier("splash_logo", "drawable", getPackageName());
        if (logo == 0) logo = getApplicationInfo().icon;
        if (logo != 0) {
            ImageView image = new ImageView(this);
            image.setImageResource(logo);
            image.setScaleType(ImageView.ScaleType.FIT_CENTER);
            LinearLayout.LayoutParams imageParams = new LinearLayout.LayoutParams(dp(80), dp(80));
            imageParams.bottomMargin = dp(20);
            splashContent.addView(image, imageParams);
        }
        TextView title = new TextView(this);
        title.setText(R.string.splash_title);
        title.setTextSize(24);
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        title.setGravity(Gravity.CENTER);
        title.setTextColor(getResources().getColor(R.color.splash_foreground));
        splashContent.addView(title);
        String subtitleText = getString(R.string.splash_subtitle);
        if (!subtitleText.isEmpty()) {
            TextView subtitle = new TextView(this);
            subtitle.setText(subtitleText);
            subtitle.setTextSize(14);
            subtitle.setGravity(Gravity.CENTER);
            subtitle.setTextColor(getResources().getColor(R.color.splash_foreground));
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
            params.topMargin = dp(12);
            splashContent.addView(subtitle, params);
        }
        root.addView(splash, new FrameLayout.LayoutParams(-1, -1));
        if (Build.VERSION.SDK_INT >= 31) {
            getSplashScreen().setOnExitAnimationListener(systemSplash -> {
                systemSplash.remove();
                startSplash(root);
            });
        } else {
            splash.post(() -> startSplash(root));
        }
    }

    private void startSplash(FrameLayout root) {
        if (isFinishing() || isDestroyed()) return;
        String animation = getString(R.string.splash_animation);
        int duration = getResources().getInteger(R.integer.splash_duration);
        boolean animate = !"none".equals(animation)
                && Settings.Global.getFloat(getContentResolver(), Settings.Global.ANIMATOR_DURATION_SCALE, 1f) > 0;
        if (animate) {
            splashAnimation = new AnimatorSet();
            ObjectAnimator fade = ObjectAnimator.ofFloat(splashContent, View.ALPHA, 0f, 1f);
            switch (animation) {
                case "zoom":
                    splashAnimation.playTogether(fade,
                            ObjectAnimator.ofFloat(splashContent, View.SCALE_X, .75f, 1f),
                            ObjectAnimator.ofFloat(splashContent, View.SCALE_Y, .75f, 1f));
                    break;
                case "slide-up":
                    splashAnimation.playTogether(fade,
                            ObjectAnimator.ofFloat(splashContent, View.TRANSLATION_Y, dp(36), 0f));
                    break;
                case "bounce":
                    splashAnimation.playTogether(fade,
                            ObjectAnimator.ofFloat(splashContent, View.TRANSLATION_Y, dp(36), -dp(12), dp(5), 0f));
                    break;
                case "rotate":
                    splashAnimation.playTogether(fade,
                            ObjectAnimator.ofFloat(splashContent, View.ROTATION, -12f, 0f),
                            ObjectAnimator.ofFloat(splashContent, View.SCALE_X, .85f, 1f),
                            ObjectAnimator.ofFloat(splashContent, View.SCALE_Y, .85f, 1f));
                    break;
                default:
                    splashAnimation.playTogether(fade);
            }
            splashAnimation.setDuration(Math.min(600, duration));
            splashAnimation.setInterpolator(new DecelerateInterpolator());
            splashAnimation.start();
        }
        dismissSplash = () -> {
            if (animate) splash.animate().alpha(0f).setDuration(200).withEndAction(() -> root.removeView(splash));
            else root.removeView(splash);
        };
        splash.postDelayed(dismissSplash, duration);
    }

    @Override
    protected void onDestroy() {
        if (splash != null && dismissSplash != null) splash.removeCallbacks(dismissSplash);
        if (splashAnimation != null) splashAnimation.cancel();
        if (splash != null) splash.animate().cancel();
        if (web != null) web.destroy();
        super.onDestroy();
    }

    private boolean looksLikeFile(Uri uri) {
        String path = uri.getPath();
        if (path == null) return false;
        String lower = path.toLowerCase();
        for (String ext : DOWNLOAD_EXTS) {
            if (lower.endsWith(ext)) return true;
        }
        return false;
    }

    private void startDownload(String url, String userAgent,
                               String contentDisposition, String mimeType) {
        // ponytail: blob:/data: URLs can't go through DownloadManager. Add a JS
        // bridge to read them out only if a target site actually needs it.
        if (!url.startsWith("http")) {
            Toast.makeText(this, "Jenis unduhan ini belum didukung", Toast.LENGTH_SHORT).show();
            return;
        }
        try {
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            if (mimeType != null) req.setMimeType(mimeType);
            if (userAgent != null) req.addRequestHeader("User-Agent", userAgent);
            // Carry the session cookie so downloads behind a login still work.
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null) req.addRequestHeader("Cookie", cookie);

            String name = URLUtil.guessFileName(url, contentDisposition, mimeType);
            req.setTitle(name);
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);

            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) throw new IllegalStateException("no DownloadManager");
            dm.enqueue(req);
            Toast.makeText(this, "Mengunduh " + name, Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, "Gagal mengunduh", Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }
}
