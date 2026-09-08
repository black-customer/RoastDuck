package com.roastduck.app;

import android.content.Context;
import android.content.SharedPreferences;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.UUID;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class SecretVaultTest {
    @Test public void missingMasterKeyDoesNotSilentlyReplaceIt() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String namespace = "roastduck.test.vault." + UUID.randomUUID();
        SecretVault vault = new SecretVault(context, namespace);
        vault.store("deepseek", "fixture-key-loss-example");
        java.security.KeyStore store = java.security.KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        store.deleteEntry(namespace + ".aes");
        try { vault.read("deepseek"); fail("Missing master key must reject"); }
        catch (java.security.GeneralSecurityException expected) { assertFalse(store.containsAlias(namespace + ".aes")); }
        vault.clear("deepseek");
    }
    @Test public void simultaneousInstancesShareOneInitialMasterKey() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String namespace = "roastduck.test.vault." + UUID.randomUUID();
        SecretVault first = new SecretVault(context, namespace), second = new SecretVault(context, namespace);
        java.util.concurrent.ExecutorService pool = java.util.concurrent.Executors.newFixedThreadPool(2);
        try {
            java.util.concurrent.Future<?> a = pool.submit(() -> { first.store("deepseek", "fixture-concurrent-first"); return null; });
            java.util.concurrent.Future<?> b = pool.submit(() -> { second.store("mimo", "fixture-concurrent-second"); return null; });
            a.get(20, java.util.concurrent.TimeUnit.SECONDS); b.get(20, java.util.concurrent.TimeUnit.SECONDS);
            assertEquals("fixture-concurrent-first", second.read("deepseek"));
            assertEquals("fixture-concurrent-second", first.read("mimo"));
        } finally { pool.shutdownNow(); first.clear("deepseek"); second.clear("mimo"); }
    }
    @Test public void ciphertextOnlyProviderScopedAndPersistent() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String namespace = "roastduck.test.vault." + UUID.randomUUID();
        SecretVault first = new SecretVault(context, namespace);
        String value = "fixture-credential-never-a-real-key";
        first.store("deepseek", value);
        assertTrue(first.configured("deepseek"));
        assertEquals(value, new SecretVault(context, namespace).read("deepseek"));
        assertNull(first.read("mimo"));
        SharedPreferences preferences = context.getSharedPreferences(namespace, Context.MODE_PRIVATE);
        for (Object stored : preferences.getAll().values()) assertFalse(String.valueOf(stored).contains(value));
        first.clear("deepseek");
        assertFalse(first.configured("deepseek"));
        assertNull(first.read("deepseek"));
    }
    @Test public void swappingProviderCiphertextFailsAuthentication() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String namespace = "roastduck.test.vault." + UUID.randomUUID();
        SecretVault vault = new SecretVault(context, namespace);
        vault.store("deepseek", "fixture-secret-for-aad-test");
        SharedPreferences preferences = context.getSharedPreferences(namespace, Context.MODE_PRIVATE);
        preferences.edit().putString("mimo.cipher", preferences.getString("deepseek.cipher", null))
            .putString("mimo.iv", preferences.getString("deepseek.iv", null)).commit();
        try { vault.read("mimo"); fail("Provider swap must not decrypt"); }
        catch (java.security.GeneralSecurityException expected) { /* no plaintext is returned */ }
        vault.clear("deepseek"); vault.clear("mimo");
    }
}
