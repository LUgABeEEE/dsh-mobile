plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val releaseStoreFile = providers.environmentVariable("DSH_ANDROID_KEYSTORE_FILE")
val releaseStorePassword = providers.environmentVariable("DSH_ANDROID_KEYSTORE_PASSWORD")
val releaseKeyAlias = providers.environmentVariable("DSH_ANDROID_KEY_ALIAS")
val releaseKeyPassword = providers.environmentVariable("DSH_ANDROID_KEY_PASSWORD")
val releaseSigningConfigured = listOf(
    releaseStoreFile,
    releaseStorePassword,
    releaseKeyAlias,
    releaseKeyPassword,
).all { it.isPresent && it.get().isNotBlank() }

// The single-App vision: the iroh transport ships in every build unless a
// caller explicitly opts out for a fast toolchain-free lane.
val irohNativeEnabled = providers.gradleProperty("irohNative").orElse("true").get() == "true"
val irohAbis = providers.gradleProperty("irohAbis").orElse("arm64-v8a,x86_64")
val irohJniOutput = layout.buildDirectory.dir("generated/iroh/jniLibs")
val irohRoot = rootProject.projectDir.resolve("../../..").canonicalFile
val irohNdk = providers.gradleProperty("irohNdk").orElse(providers.environmentVariable("ANDROID_NDK_HOME"))
val buildIrohTransport = tasks.register<Exec>("buildIrohTransport") {
    group = "build"
    description = "Build and verify selected Rust Android ABIs with an explicitly selected NDK"
    onlyIf { irohNativeEnabled }
    inputs.dir(irohRoot.resolve("native/iroh-android-transport/src"))
    inputs.file(irohRoot.resolve("native/iroh-android-transport/Cargo.toml"))
    inputs.dir(irohRoot.resolve("native/iroh-core/src"))
    inputs.file(irohRoot.resolve("native/iroh-core/Cargo.toml"))
    inputs.file(irohRoot.resolve("native/Cargo.lock"))
    inputs.file(irohRoot.resolve("scripts/build-android-transport.mjs"))
    inputs.property("abis", irohAbis)
    inputs.property("ndk", irohNdk.orElse("not-configured"))
    if (irohNativeEnabled && irohNdk.isPresent) inputs.file(file(irohNdk.get()).resolve("source.properties"))
    outputs.dir(irohJniOutput)
    doFirst {
        val selectedNdk = irohNdk.orNull
            ?: error("Native builds require -PirohNdk=<NDK directory> or ANDROID_NDK_HOME")
        commandLine(
            "node", irohRoot.resolve("scripts/build-android-transport.mjs").absolutePath,
            "--ndk", selectedNdk,
            "--abis", irohAbis.get(),
            "--output", irohJniOutput.get().asFile.absolutePath,
        )
    }
}

android {
    namespace = "io.github.sayach.dshmobile"
    compileSdk = 36

    defaultConfig {
        applicationId = "io.github.sayach.dshmobile"
        minSdk = 29
        targetSdk = 36
        versionCode = 84
        versionName = "0.6.8"
        buildConfigField("boolean", "IROH_NATIVE_ENABLED", irohNativeEnabled.toString())
    }

    signingConfigs {
        create("release") {
            if (releaseSigningConfigured) {
                storeFile = file(releaseStoreFile.get())
                storePassword = releaseStorePassword.get()
                keyAlias = releaseKeyAlias.get()
                keyPassword = releaseKeyPassword.get()
            }
        }
    }

    buildTypes {
        debug {
            // Installable beside the release app: a distinct applicationId makes
            // Android treat this as a separate app with its own data and pairing.
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        release {
            isMinifyEnabled = true
            if (releaseSigningConfigured) signingConfig = signingConfigs.getByName("release")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
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
        buildConfig = true
    }

    lint {
        checkTestSources = false
    }

    sourceSets.getByName("test").resources.srcDir("../../contract")
    if (irohNativeEnabled) {
        sourceSets.getByName("main").jniLibs.srcDir(irohJniOutput)
    }
    packaging.jniLibs.useLegacyPackaging = false
    // The selected NDK strips and verifies these libraries before Gradle packages them.
    packaging.jniLibs.keepDebugSymbols.add("**/libdsh_mobile_iroh_android_transport.so")
}

if (irohNativeEnabled) {
    tasks.named("preBuild").configure { dependsOn(buildIrohTransport) }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.webkit:webkit:1.17.1")
    implementation("com.google.zxing:core:3.5.4")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20260814")
}
