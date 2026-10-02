import java.io.FileInputStream
import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

/**
 * The watch app is signed with the same key as the phone app. That is not a convenience: the Wear OS data layer only
 * delivers the phone's "send to the watch" message to an app with the same package name and the same signing
 * certificate on the other side. The key lives next to the phone app's (mobile/android, untracked); without it
 * (a fresh clone, CI) the build still works and produces an APK signed with the debug key, which installs on a watch
 * but cannot be configured from the phone.
 */
val keystorePropertiesFile = rootProject.file("../mobile/android/keystore.properties")
val keystoreProperties = Properties().apply {
    if (keystorePropertiesFile.exists()) FileInputStream(keystorePropertiesFile).use { load(it) }
}

android {
    namespace = "com.selfhosthub.wear"
    compileSdk = 36

    defaultConfig {
        // The phone app's id: the data layer matches the two apps by it.
        applicationId = "com.selfhosthub.mobile"
        minSdk = 30
        targetSdk = 36
        // Follows the version of the repository (major * 10000 + minor * 100 + patch).
        versionCode = 20400
        versionName = "2.4.0"
    }

    signingConfigs {
        if (keystorePropertiesFile.exists()) {
            create("shared") {
                // The phone project resolves "storeFile" from its app folder.
                storeFile = rootProject.file("../mobile/android/app/" + keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            // Same package and same key as the release build, so that the phone can talk to it too.
            signingConfig = signingConfigs.findByName("shared") ?: signingConfigs.getByName("debug")
            isMinifyEnabled = false
        }
        release {
            signingConfig = signingConfigs.findByName("shared") ?: signingConfigs.getByName("debug")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
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
        compose = true
        buildConfig = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }

    lint {
        // The repository's own checks are the tests; lint is run by hand and its report read, not gated on.
        abortOnError = false
    }
}

dependencies {
    implementation(project(":core"))
    implementation(project(":data"))
    implementation(project(":service"))
    implementation(project(":ui"))

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.androidx.wear)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.wear.compose.material)
}
