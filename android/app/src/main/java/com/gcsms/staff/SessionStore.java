package com.gcsms.staff;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

import java.io.IOException;
import java.security.GeneralSecurityException;

public final class SessionStore {
    private final SharedPreferences preferences;

    public SessionStore(Context context) {
        try {
            MasterKey key = new MasterKey.Builder(context)
                    .setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build();
            preferences = EncryptedSharedPreferences.create(
                    context, "staff_session", key,
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
        } catch (GeneralSecurityException | IOException error) {
            throw new IllegalStateException("Unable to initialize encrypted session storage", error);
        }
    }

    public String accessToken() { return preferences.getString("access", null); }
    public String refreshToken() { return preferences.getString("refresh", null); }

    public void save(String access, String refresh) {
        preferences.edit().putString("access", access).putString("refresh", refresh).apply();
    }

    public void clear() {
        preferences.edit().clear().apply();
    }
}
