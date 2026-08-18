// アプリ本体のビルド設定
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.hono.mycamera"

    // compileSdk / targetSdk は「最新」を指す番号です。
    // 将来もっと新しいAndroidバージョンが出たら、この2つの数字を
    // 新しいAPIレベルに書き換えるだけで対応できます（README参照）。
    compileSdk = 35

    defaultConfig {
        applicationId = "com.hono.mycamera"
        // Android 12 (API 31) 以降のみで動作
        minSdk = 31
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
    }

    signingConfigs {
        create("release") {
            storeFile = file("../keystore/release.keystore")
            storePassword = "mycamera123"
            keyAlias = "mycamera"
            keyPassword = "mycamera123"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
        debug {
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        viewBinding = false
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("androidx.activity:activity-ktx:1.9.1")
}
