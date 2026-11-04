package com.gcsms.staff;

import android.content.Context;

import com.google.gson.Gson;

import java.io.IOException;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

import okhttp3.Authenticator;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.Route;
import retrofit2.Retrofit;
import retrofit2.converter.gson.GsonConverterFactory;

public final class ApiClient {
    // For the Android emulator use 10.0.2.2 to reach a Flask server on the host machine.
    public static final String BASE_URL = "http://10.0.2.2:5000/api/v1/";
    private static ApiClient instance;
    private final SessionStore session;
    private final ApiService service;

    private ApiClient(Context context) {
        session = new SessionStore(context.getApplicationContext());
        OkHttpClient client = new OkHttpClient.Builder()
                .addInterceptor(chain -> {
                    Request original = chain.request();
                    String token = session.accessToken();
                    if (token == null) return chain.proceed(original);
                    return chain.proceed(original.newBuilder()
                            .header("Authorization", "Bearer " + token).build());
                })
                .authenticator(new TokenAuthenticator(session))
                .build();
        service = new Retrofit.Builder().baseUrl(BASE_URL).client(client)
                .addConverterFactory(GsonConverterFactory.create()).build().create(ApiService.class);
    }

    public static synchronized ApiClient get(Context context) {
        if (instance == null) instance = new ApiClient(context);
        return instance;
    }

    public ApiService service() { return service; }
    public SessionStore session() { return session; }

    private static class TokenAuthenticator implements Authenticator {
        private final SessionStore session;

        TokenAuthenticator(SessionStore session) { this.session = session; }

        @Override public Request authenticate(Route route, Response response) throws IOException {
            if (responseCount(response) >= 2) return null;
            synchronized (session) {
                String current = session.accessToken();
                String sent = response.request().header("Authorization");
                if (current != null && !("Bearer " + current).equals(sent)) {
                    return response.request().newBuilder().header("Authorization", "Bearer " + current).build();
                }
                String refreshToken = session.refreshToken();
                if (refreshToken == null) return null;
                OkHttpClient refreshClient = new OkHttpClient();
                Retrofit refreshRetrofit = new Retrofit.Builder().baseUrl(BASE_URL).client(refreshClient)
                        .addConverterFactory(GsonConverterFactory.create()).build();
                ApiService auth = refreshRetrofit.create(ApiService.class);
                Map<String, String> body = new HashMap<>();
                body.put("refresh_token", refreshToken);
                retrofit2.Response<ApiModels.Envelope<ApiModels.Tokens>> refreshed =
                        auth.refresh(body).execute();
                if (!refreshed.isSuccessful() || refreshed.body() == null
                        || refreshed.body().data == null) {
                    session.clear();
                    return null;
                }
                ApiModels.Tokens tokens = refreshed.body().data;
                session.save(tokens.access_token, tokens.refresh_token);
                return response.request().newBuilder()
                        .header("Authorization", "Bearer " + tokens.access_token).build();
            }
        }

        private int responseCount(Response response) {
            int count = 1;
            while ((response = response.priorResponse()) != null) count++;
            return count;
        }
    }
}
