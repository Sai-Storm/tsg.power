package com.gcsms.staff;

import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import retrofit2.Call;
import retrofit2.Callback;
import retrofit2.Response;

public class MainActivity extends AppCompatActivity {
    private ApiClient api;
    private LinearLayout loginPanel;
    private LinearLayout jobsPanel;
    private EditText emailInput;
    private EditText passwordInput;
    private ListView jobsList;
    private List<ApiModels.Job> jobs = new ArrayList<>();

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.activity_main);
        api = ApiClient.get(this);
        loginPanel = findViewById(R.id.loginPanel);
        jobsPanel = findViewById(R.id.jobsPanel);
        emailInput = findViewById(R.id.emailInput);
        passwordInput = findViewById(R.id.passwordInput);
        jobsList = findViewById(R.id.jobsList);
        findViewById(R.id.loginButton).setOnClickListener(v -> login());
        findViewById(R.id.refreshButton).setOnClickListener(v -> loadJobs());
        findViewById(R.id.logoutButton).setOnClickListener(v -> logout());
        jobsList.setOnItemClickListener((parent, view, position, id) -> {
            ApiModels.Job job = jobs.get(position);
            startActivity(new Intent(this, JobDetailActivity.class).putExtra("job_id", job.id));
        });
        showScreen(api.session().accessToken() == null);
        if (api.session().accessToken() != null) loadJobs();
    }

    private void login() {
        Map<String, String> body = new HashMap<>();
        body.put("email", emailInput.getText().toString().trim());
        body.put("password", passwordInput.getText().toString());
        body.put("device_name", android.os.Build.MODEL);
        api.service().login(body).enqueue(new Callback<ApiModels.Envelope<ApiModels.Tokens>>() {
            @Override public void onResponse(Call<ApiModels.Envelope<ApiModels.Tokens>> call,
                                             Response<ApiModels.Envelope<ApiModels.Tokens>> response) {
                if (!response.isSuccessful() || response.body() == null || response.body().data == null) {
                    toast("Sign in failed. Check your email and password.");
                    return;
                }
                ApiModels.Tokens tokens = response.body().data;
                api.session().save(tokens.access_token, tokens.refresh_token);
                passwordInput.setText("");
                showScreen(false);
                loadJobs();
            }
            @Override public void onFailure(Call<ApiModels.Envelope<ApiModels.Tokens>> call, Throwable error) {
                toast("Unable to reach the server. Check your connection.");
            }
        });
    }

    private void loadJobs() {
        api.service().jobs(1, 100).enqueue(new Callback<ApiModels.Envelope<List<ApiModels.Job>>>() {
            @Override public void onResponse(Call<ApiModels.Envelope<List<ApiModels.Job>>> call,
                                             Response<ApiModels.Envelope<List<ApiModels.Job>>> response) {
                if (!response.isSuccessful() || response.body() == null || response.body().data == null) {
                    if (response.code() == 401) {
                        api.session().clear();
                        showScreen(true);
                    } else toast("Could not load jobs.");
                    return;
                }
                jobs = response.body().data;
                jobsList.setAdapter(new ArrayAdapter<>(MainActivity.this,
                        android.R.layout.simple_list_item_1, jobs));
            }
            @Override public void onFailure(Call<ApiModels.Envelope<List<ApiModels.Job>>> call, Throwable error) {
                toast("Unable to load jobs.");
            }
        });
    }

    private void logout() {
        api.service().logout().enqueue(new Callback<ApiModels.Envelope<Map<String, Boolean>>>() {
            @Override public void onResponse(Call<ApiModels.Envelope<Map<String, Boolean>>> call,
                                             Response<ApiModels.Envelope<Map<String, Boolean>>> response) {
                api.session().clear();
                showScreen(true);
            }
            @Override public void onFailure(Call<ApiModels.Envelope<Map<String, Boolean>>> call, Throwable error) {
                api.session().clear();
                showScreen(true);
            }
        });
    }

    private void showScreen(boolean login) {
        loginPanel.setVisibility(login ? View.VISIBLE : View.GONE);
        jobsPanel.setVisibility(login ? View.GONE : View.VISIBLE);
    }

    private void toast(String message) { Toast.makeText(this, message, Toast.LENGTH_LONG).show(); }
}
