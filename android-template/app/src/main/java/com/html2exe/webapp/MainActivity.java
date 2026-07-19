package __PACKAGE_NAME__;

import android.Manifest;
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
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.URLUtil;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

public class MainActivity extends Activity {
    private WebView web;
    private String host;

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

        setContentView(web);
        web.loadUrl(target);
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
