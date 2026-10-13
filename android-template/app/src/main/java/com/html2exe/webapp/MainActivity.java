package __PACKAGE_NAME__;

import android.Manifest;
import android.animation.AnimatorSet;
import android.animation.Animator;
import android.animation.ObjectAnimator;
import android.animation.ValueAnimator;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.drawable.GradientDrawable;
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
import android.view.animation.LinearInterpolator;
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
import android.widget.ScrollView;
import java.util.ArrayList;

public class MainActivity extends Activity {
    private WebView web;
    private String host;
    private FrameLayout splash;
    private LinearLayout splashContent;
    private Runnable dismissSplash;
    private AnimatorSet splashAnimation;
    private AnimatorSet splashLoops;
    private FrameLayout logoTile;
    private LoadingIndicator loadingIndicator;
    private boolean splashStarted;

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
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.addView(splashContent, new ScrollView.LayoutParams(-1, -2));
        splash.addView(scroll, new FrameLayout.LayoutParams(-1, -1));
        int foreground = getResources().getColor(R.color.splash_foreground);
        logoTile = new FrameLayout(this);
        GradientDrawable tileBackground = new GradientDrawable();
        tileBackground.setColor((foreground & 0x00ffffff) | 0x0d000000);
        tileBackground.setCornerRadius(dp(28));
        tileBackground.setStroke(dp(1), (foreground & 0x00ffffff) | 0x33000000);
        logoTile.setBackground(tileBackground);
        logoTile.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        LinearLayout.LayoutParams tileParams = new LinearLayout.LayoutParams(dp(104), dp(104));
        tileParams.bottomMargin = dp(24);
        splashContent.addView(logoTile, tileParams);
        int logo = getResources().getIdentifier("splash_logo", "drawable", getPackageName());
        if (logo == 0) logo = getApplicationInfo().icon;
        if (logo != 0) {
            ImageView image = new ImageView(this);
            image.setImageResource(logo);
            image.setScaleType(ImageView.ScaleType.FIT_CENTER);
            logoTile.addView(image, new FrameLayout.LayoutParams(dp(72), dp(72), Gravity.CENTER));
        } else {
            TextView initial = new TextView(this);
            String name = getString(R.string.splash_title);
            initial.setText(name.isEmpty() ? "A" : name.substring(0, name.offsetByCodePoints(0, 1)).toUpperCase());
            initial.setTextSize(36);
            initial.setTextColor(foreground);
            initial.setGravity(Gravity.CENTER);
            initial.setTypeface(null, android.graphics.Typeface.BOLD);
            logoTile.addView(initial, new FrameLayout.LayoutParams(-1, -1));
        }
        TextView title = new TextView(this);
        title.setText(R.string.splash_title);
        title.setTextSize(28);
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
        if (!"none".equals(getString(R.string.splash_loader))) {
            loadingIndicator = new LoadingIndicator(this);
            LinearLayout.LayoutParams loaderParams = new LinearLayout.LayoutParams(dp(72), dp(28));
            loaderParams.topMargin = dp(28);
            splashContent.addView(loadingIndicator, loaderParams);
            TextView caption = new TextView(this);
            caption.setText("Menyiapkan aplikasi");
            caption.setTextSize(12);
            caption.setTextColor(foreground);
            caption.setGravity(Gravity.CENTER);
            LinearLayout.LayoutParams captionParams = new LinearLayout.LayoutParams(-1, -2);
            captionParams.topMargin = dp(10);
            splashContent.addView(caption, captionParams);
        }
        root.addView(splash, new FrameLayout.LayoutParams(-1, -1));
        dismissSplash = () -> {
            if (splashLoops != null) splashLoops.cancel();
            if (splashAnimation != null) splashAnimation.cancel();
            root.removeView(splash);
        };
        // Close even if the activity never receives focus or a system splash callback.
        splash.postDelayed(dismissSplash, 10000);
        splash.post(() -> { if (hasWindowFocus()) startSplash(); });
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) startSplash();
    }

    private void startSplash() {
        if (splashStarted || splash == null || splash.getParent() == null || isFinishing() || isDestroyed()) return;
        splashStarted = true;
        String animation = getString(R.string.splash_animation);
        int duration = getResources().getInteger(R.integer.splash_duration);
        splash.removeCallbacks(dismissSplash);
        splash.postDelayed(dismissSplash, duration);
        boolean motion = Settings.Global.getFloat(getContentResolver(), Settings.Global.ANIMATOR_DURATION_SCALE, 1f) > 0;
        boolean animate = !"none".equals(animation) && motion;
        if (animate) {
            splashAnimation = new AnimatorSet();
            ObjectAnimator fade = ObjectAnimator.ofFloat(splashContent, View.ALPHA, 0f, 1f);
            switch (animation) {
                case "pulse":
                case "zoom":
                    splashAnimation.playTogether(fade,
                            ObjectAnimator.ofFloat(splashContent, View.SCALE_X, .75f, 1f),
                            ObjectAnimator.ofFloat(splashContent, View.SCALE_Y, .75f, 1f));
                    break;
                case "flip":
                    splashAnimation.playTogether(fade,
                            ObjectAnimator.ofFloat(splashContent, View.ROTATION_X, -45f, 0f));
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
        if (motion) {
            ArrayList<Animator> loops = new ArrayList<>();
            if (loadingIndicator != null) {
                ValueAnimator loaderAnimation = ValueAnimator.ofFloat(0f, 1f);
                loaderAnimation.setDuration(1200);
                loaderAnimation.setRepeatCount(ValueAnimator.INFINITE);
                loaderAnimation.setInterpolator(new LinearInterpolator());
                loaderAnimation.addUpdateListener(value -> {
                    loadingIndicator.phase = (float) value.getAnimatedValue();
                    loadingIndicator.invalidate();
                });
                loops.add(loaderAnimation);
            }
            if ("pulse".equals(animation)) {
                for (String scale : new String[]{"scaleX", "scaleY"}) {
                    ObjectAnimator pulse = ObjectAnimator.ofFloat(logoTile, scale, 1f, 1.07f, 1f);
                    pulse.setDuration(1400);
                    pulse.setRepeatCount(ValueAnimator.INFINITE);
                    loops.add(pulse);
                }
            }
            splashLoops = new AnimatorSet();
            splashLoops.playTogether(loops);
            splashLoops.start();
        }
    }

    @Override
    protected void onDestroy() {
        if (splash != null && dismissSplash != null) splash.removeCallbacks(dismissSplash);
        if (splashAnimation != null) splashAnimation.cancel();
        if (splashLoops != null) splashLoops.cancel();
        if (splash != null) splash.animate().cancel();
        if (web != null) web.destroy();
        super.onDestroy();
    }

    private class LoadingIndicator extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final String style = getString(R.string.splash_loader);
        private float phase = .25f;

        LoadingIndicator(Context context) {
            super(context);
            paint.setColor(getResources().getColor(R.color.splash_foreground));
            setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        }

        @Override
        protected void onDraw(Canvas canvas) {
            super.onDraw(canvas);
            float x = getWidth() / 2f, y = getHeight() / 2f;
            if ("dots".equals(style) || "bars".equals(style)) {
                paint.setStyle(Paint.Style.FILL);
                for (int i = 0; i < 3; i++) {
                    float wave = (float) Math.max(0, Math.sin(phase * Math.PI * 2 - i * .8));
                    if ("dots".equals(style)) {
                        canvas.drawCircle(x + (i - 1) * dp(14), y - dp(6) * wave, dp(3), paint);
                    } else {
                        float height = dp(8) + dp(14) * wave, center = x + (i - 1) * dp(10);
                        canvas.drawRoundRect(center - dp(2), y - height / 2, center + dp(2), y + height / 2, dp(2), dp(2), paint);
                    }
                }
            } else {
                paint.setStyle(Paint.Style.STROKE);
                paint.setStrokeWidth(dp(2));
                paint.setStrokeCap(Paint.Cap.ROUND);
                if ("spinner".equals(style)) {
                    canvas.drawArc(x - dp(10), y - dp(10), x + dp(10), y + dp(10), phase * 360, 270, false, paint);
                } else {
                    float wave = (float) (.5 - .5 * Math.cos(phase * Math.PI * 2));
                    paint.setAlpha((int) (115 + 140 * wave));
                    canvas.drawCircle(x, y, dp(8) + dp(4) * wave, paint);
                }
            }
        }
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
