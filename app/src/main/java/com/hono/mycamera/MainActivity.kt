package com.hono.mycamera

import android.Manifest
import android.content.ContentValues
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    // カメラ・マイクの権限をまとめてリクエストするためのランチャー
    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { result ->
        val allGranted = result.values.all { it }
        if (!allGranted) {
            Toast.makeText(
                this,
                "カメラとマイクの権限を許可しないとアプリを使用できません",
                Toast.LENGTH_LONG
            ).show()
        }
        // 権限の結果に関わらずWebViewを読み込む（WebView側の getUserMedia が
        // 権限なしの場合は失敗し、画面上にメッセージが表示される）
        webView.loadUrl("file:///android_asset/www/index.html")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 画面を常時点灯（撮影中にスリープしないように）
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        // 全画面（ステータスバー等を隠す没入モード）
        hideSystemBars()

        webView = WebView(this)
        setContentView(webView)
        setupWebView()

        val needed = arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)
        val notGranted = needed.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (notGranted.isEmpty()) {
            webView.loadUrl("file:///android_asset/www/index.html")
        } else {
            permissionLauncher.launch(needed)
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    private fun hideSystemBars() {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            )
    }

    @Suppress("SetJavaScriptEnabled")
    private fun setupWebView() {
        val settings: WebSettings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.allowFileAccess = true
        settings.cacheMode = WebSettings.LOAD_DEFAULT

        webView.addJavascriptInterface(WebAppInterface(this), "AndroidBridge")

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    val granted = request.resources.all { res ->
                        when (res) {
                            PermissionRequest.RESOURCE_VIDEO_CAPTURE ->
                                ContextCompat.checkSelfPermission(
                                    this@MainActivity, Manifest.permission.CAMERA
                                ) == PackageManager.PERMISSION_GRANTED
                            PermissionRequest.RESOURCE_AUDIO_CAPTURE ->
                                ContextCompat.checkSelfPermission(
                                    this@MainActivity, Manifest.permission.RECORD_AUDIO
                                ) == PackageManager.PERMISSION_GRANTED
                            else -> false
                        }
                    }
                    if (granted) {
                        request.grant(request.resources)
                    } else {
                        request.deny()
                    }
                }
            }
        }
    }

    /** JavaScript側（www/app.js）から呼び出されるブリッジ。写真・動画をMediaStoreに保存する。 */
    inner class WebAppInterface(private val activity: MainActivity) {

        @JavascriptInterface
        fun saveImage(base64Data: String): String {
            return try {
                val bytes = decodeBase64(base64Data)
                val name = "IMG_${System.currentTimeMillis()}.jpg"
                val values = ContentValues().apply {
                    put(MediaStore.Images.Media.DISPLAY_NAME, name)
                    put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
                    put(
                        MediaStore.Images.Media.RELATIVE_PATH,
                        Environment.DIRECTORY_PICTURES + "/MyCamera"
                    )
                }
                val resolver = activity.contentResolver
                val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
                    ?: return "error"
                resolver.openOutputStream(uri)?.use { it.write(bytes) }
                activity.runOnUiThread {
                    Toast.makeText(activity, "写真を保存しました", Toast.LENGTH_SHORT).show()
                }
                "ok"
            } catch (e: Exception) {
                activity.runOnUiThread {
                    Toast.makeText(activity, "保存に失敗しました: ${e.message}", Toast.LENGTH_LONG).show()
                }
                "error"
            }
        }

        @JavascriptInterface
        fun saveVideo(base64Data: String, mimeType: String): String {
            return try {
                val bytes = decodeBase64(base64Data)
                val ext = if (mimeType.contains("mp4")) "mp4" else "webm"
                val name = "VID_${System.currentTimeMillis()}.$ext"
                val values = ContentValues().apply {
                    put(MediaStore.Video.Media.DISPLAY_NAME, name)
                    put(MediaStore.Video.Media.MIME_TYPE, mimeType)
                    put(
                        MediaStore.Video.Media.RELATIVE_PATH,
                        Environment.DIRECTORY_MOVIES + "/MyCamera"
                    )
                }
                val resolver = activity.contentResolver
                val uri = resolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values)
                    ?: return "error"
                resolver.openOutputStream(uri)?.use { it.write(bytes) }
                activity.runOnUiThread {
                    Toast.makeText(activity, "動画を保存しました", Toast.LENGTH_SHORT).show()
                }
                "ok"
            } catch (e: Exception) {
                activity.runOnUiThread {
                    Toast.makeText(activity, "保存に失敗しました: ${e.message}", Toast.LENGTH_LONG).show()
                }
                "error"
            }
        }

        private fun decodeBase64(dataUrl: String): ByteArray {
            // "data:image/jpeg;base64,xxxx" のようなdata URL形式にも対応
            val comma = dataUrl.indexOf(",")
            val pure = if (dataUrl.startsWith("data:") && comma != -1) {
                dataUrl.substring(comma + 1)
            } else {
                dataUrl
            }
            return Base64.decode(pure, Base64.DEFAULT)
        }
    }
}
