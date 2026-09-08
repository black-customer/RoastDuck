package com.roastduck.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Credentials stay native. Only this encrypted preference file contains API ciphertext. */
final class SecretVault {
    private static final Object KEY_CREATION_LOCK = new Object();
    private final SharedPreferences preferences;
    private final String alias;

    SecretVault(Context context) { this(context, "roastduck.credentials.v1"); }
    SecretVault(Context context, String namespace) {
        preferences = context.getSharedPreferences(namespace, Context.MODE_PRIVATE);
        alias = namespace + ".aes";
    }
    private static void validateProvider(String provider) {
        if(provider==null)throw new IllegalArgumentException("Unknown provider");
        if (!"deepseek".equals(provider) && !"mimo".equals(provider) && !provider.matches("pair_[a-z0-9_]{1,70}")) throw new IllegalArgumentException("Unknown provider");
    }
    private SecretKey key(boolean create) throws GeneralSecurityException, IOException {
      synchronized (KEY_CREATION_LOCK) {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(alias)) return (SecretKey) store.getKey(alias, null);
        if (!create) throw new GeneralSecurityException("Native credential key unavailable");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true).build());
        return generator.generateKey();
      }
    }
    synchronized void store(String provider, String value) throws GeneralSecurityException, IOException {
        validateProvider(provider);
        if (value == null || !value.matches("[A-Za-z0-9._-]{8,512}")) throw new IllegalArgumentException("Invalid credential format");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key(true));
        cipher.updateAAD(provider.getBytes(StandardCharsets.UTF_8));
        String encrypted = Base64.encodeToString(cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
        String iv = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP);
        if (!preferences.edit().putString(provider + ".cipher", encrypted).putString(provider + ".iv", iv).commit()) throw new IOException("Credential persistence failed");
    }
    synchronized String read(String provider) throws GeneralSecurityException, IOException {
        validateProvider(provider);
        String encrypted = preferences.getString(provider + ".cipher", null);
        String iv = preferences.getString(provider + ".iv", null);
        if (encrypted == null || iv == null) return null;
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
        cipher.updateAAD(provider.getBytes(StandardCharsets.UTF_8));
        return new String(cipher.doFinal(Base64.decode(encrypted, Base64.NO_WRAP)), StandardCharsets.UTF_8);
    }
    synchronized boolean configured(String provider) {
        validateProvider(provider);
        return preferences.contains(provider + ".cipher") && preferences.contains(provider + ".iv");
    }
    synchronized void clear(String provider) throws IOException {
        validateProvider(provider);
        if (!preferences.edit().remove(provider + ".cipher").remove(provider + ".iv").commit()) throw new IOException("Credential removal failed");
    }
}
