# NativeBridge is reached through androidx.webkit's typed WebMessageListener;
# it exposes no reflection-addressed Java methods to page JavaScript.

# ZXing readers are selected dynamically through decode hints.
-keep class com.google.zxing.** { *; }

# Rust accesses these classes by JNI symbols and class-loader lookup.
-keep class io.github.sayach.dshmobile.IrohNative { *; }
-keep,includedescriptorclasses class org.rustls.platformverifier.** { *; }
