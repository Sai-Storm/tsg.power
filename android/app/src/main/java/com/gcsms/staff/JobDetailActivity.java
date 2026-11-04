package com.gcsms.staff;

import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.database.Cursor;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;

import java.io.IOException;
import java.util.List;
import java.util.Map;

import okhttp3.MediaType;
import okhttp3.MultipartBody;
import okhttp3.RequestBody;
import okio.BufferedSink;
import retrofit2.Call;
import retrofit2.Callback;
import retrofit2.Response;

public class JobDetailActivity extends AppCompatActivity {
    private static final int PICK_PHOTO = 41;
    private ApiClient api;
    private int jobId;
    private TextView title;
    private TextView details;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.activity_job_detail);
        api = ApiClient.get(this);
        jobId = getIntent().getIntExtra("job_id", 0);
        title = findViewById(R.id.jobTitle);
        details = findViewById(R.id.jobDetails);
        findViewById(R.id.historyButton).setOnClickListener(v -> showHistory());
        findViewById(R.id.materialsButton).setOnClickListener(v -> showMaterials());
        findViewById(R.id.photoButton).setOnClickListener(v -> pickPhoto());
        findViewById(R.id.completeButton).setOnClickListener(v -> completionDialog());
        loadJob();
    }

    private void loadJob() {
        api.service().job(jobId).enqueue(new Callback<ApiModels.Envelope<ApiModels.Job>>() {
            @Override public void onResponse(Call<ApiModels.Envelope<ApiModels.Job>> call,
                                             Response<ApiModels.Envelope<ApiModels.Job>> response) {
                if (!response.isSuccessful() || response.body() == null || response.body().data == null) {
                    toast("Could not load this job.");
                    finish();
                    return;
                }
                ApiModels.Job job = response.body().data;
                title.setText(job.service_id + " — " + job.status_label);
                String customer = job.customer == null ? "" : job.customer.name + "\n"
                        + job.customer.phone_primary + "\n" + job.customer.address;
                String generator = job.generator == null ? "" : "\n\n" + job.generator.brand + " "
                        + job.generator.model + " · S/N " + job.generator.serial_number;
                details.setText(customer + generator + "\n\n" + job.complaint
                        + (job.location == null ? "" : "\n\nLocation: " + job.location));
            }
            @Override public void onFailure(Call<ApiModels.Envelope<ApiModels.Job>> call, Throwable error) {
                toast("Unable to load this job.");
            }
        });
    }

    private void showHistory() {
        api.service().history(jobId).enqueue(new Callback<ApiModels.Envelope<List<ApiModels.HistoryItem>>>() {
            @Override public void onResponse(Call<ApiModels.Envelope<List<ApiModels.HistoryItem>>> call,
                                             Response<ApiModels.Envelope<List<ApiModels.HistoryItem>>> response) {
                if (!response.isSuccessful() || response.body() == null || response.body().data == null) {
                    toast("Could not load job history.");
                    return;
                }
                StringBuilder text = new StringBuilder();
                for (ApiModels.HistoryItem item : response.body().data) {
                    text.append(item.at).append("\n").append(item.title == null ? item.kind : item.title)
                            .append(item.detail == null ? "" : "\n" + item.detail).append("\n\n");
                }
                new AlertDialog.Builder(JobDetailActivity.this).setTitle("Job history")
                        .setMessage(text.length() == 0 ? "No history yet." : text.toString())
                        .setPositiveButton("Close", null).show();
            }
            @Override public void onFailure(Call<ApiModels.Envelope<List<ApiModels.HistoryItem>>> call, Throwable error) {
                toast("Unable to load job history.");
            }
        });
    }

    private void showMaterials() {
        api.service().materials(jobId).enqueue(new Callback<ApiModels.Envelope<List<Map<String, Object>>>>() {
            @Override public void onResponse(Call<ApiModels.Envelope<List<Map<String, Object>>>> call,
                                             Response<ApiModels.Envelope<List<Map<String, Object>>>> response) {
                if (!response.isSuccessful() || response.body() == null || response.body().data == null) {
                    toast("Could not load materials.");
                    return;
                }
                StringBuilder text = new StringBuilder();
                for (Map<String, Object> item : response.body().data) {
                    text.append(item.get("description")).append(" · ").append(item.get("status"))
                            .append(" · requested ").append(item.get("requested_qty")).append("\n");
                }
                new AlertDialog.Builder(JobDetailActivity.this).setTitle("Materials")
                        .setMessage(text.length() == 0 ? "No material requests." : text.toString())
                        .setPositiveButton("Close", null)
                        .setNeutralButton("Request", (dialog, which) -> materialDialog()).show();
            }
            @Override public void onFailure(Call<ApiModels.Envelope<List<Map<String, Object>>>> call, Throwable error) {
                toast("Unable to load materials.");
            }
        });
    }

    private void materialDialog() {
        EditText description = new EditText(this);
        description.setHint("Material description");
        EditText quantity = new EditText(this);
        quantity.setHint("Quantity");
        quantity.setInputType(android.text.InputType.TYPE_CLASS_NUMBER
                | android.text.InputType.TYPE_NUMBER_FLAG_DECIMAL);
        android.widget.LinearLayout fields = new android.widget.LinearLayout(this);
        fields.setOrientation(android.widget.LinearLayout.VERTICAL);
        fields.setPadding(40, 8, 40, 0);
        fields.addView(description);
        fields.addView(quantity);
        new AlertDialog.Builder(this).setTitle("Request material").setView(fields)
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Submit", (dialog, which) -> {
                    ApiModels.MaterialRequest body = new ApiModels.MaterialRequest();
                    body.description = description.getText().toString().trim();
                    body.quantity = quantity.getText().toString().trim();
                    body.unit = "unit";
                    body.category = "special_material";
                    api.service().addMaterial(jobId, body).enqueue(new Callback<ApiModels.Envelope<Map<String, Object>>>() {
                        @Override public void onResponse(Call<ApiModels.Envelope<Map<String, Object>>> call,
                                                         Response<ApiModels.Envelope<Map<String, Object>>> response) {
                            toast(response.isSuccessful() ? "Material request added." : "Could not add request.");
                        }
                        @Override public void onFailure(Call<ApiModels.Envelope<Map<String, Object>>> call, Throwable error) {
                            toast("Unable to send material request.");
                        }
                    });
                }).show();
    }

    private void completionDialog() {
        android.widget.LinearLayout fields = new android.widget.LinearLayout(this);
        fields.setOrientation(android.widget.LinearLayout.VERTICAL);
        fields.setPadding(40, 8, 40, 0);
        EditText diagnosis = field("Diagnosis");
        EditText work = field("Work performed");
        EditText hours = field("Labor hours");
        hours.setInputType(android.text.InputType.TYPE_CLASS_NUMBER | android.text.InputType.TYPE_NUMBER_FLAG_DECIMAL);
        EditText remarks = field("Completion remarks");
        fields.addView(diagnosis);
        fields.addView(work);
        fields.addView(hours);
        fields.addView(remarks);
        new AlertDialog.Builder(this).setTitle("Complete job").setView(fields)
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Submit", (dialog, which) -> {
                    ApiModels.Completion body = new ApiModels.Completion();
                    body.diagnosis = diagnosis.getText().toString().trim();
                    body.work_performed = work.getText().toString().trim();
                    body.labor_hours = hours.getText().toString().trim();
                    body.completion_remarks = remarks.getText().toString().trim();
                    body.actual_completion = new java.text.SimpleDateFormat("yyyy-MM-dd",
                            java.util.Locale.US).format(new java.util.Date());
                    api.service().complete(jobId, body).enqueue(new Callback<ApiModels.Envelope<ApiModels.Job>>() {
                        @Override public void onResponse(Call<ApiModels.Envelope<ApiModels.Job>> call,
                                                         Response<ApiModels.Envelope<ApiModels.Job>> response) {
                            toast(response.isSuccessful() ? "Job completed." : "Completion was not accepted.");
                            if (response.isSuccessful()) loadJob();
                        }
                        @Override public void onFailure(Call<ApiModels.Envelope<ApiModels.Job>> call, Throwable error) {
                            toast("Unable to submit completion report.");
                        }
                    });
                }).show();
    }

    private EditText field(String hint) {
        EditText input = new EditText(this);
        input.setHint(hint);
        return input;
    }

    private void pickPhoto() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.setType("image/*");
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        startActivityForResult(intent, PICK_PHOTO);
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, @Nullable Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == PICK_PHOTO && resultCode == RESULT_OK && data != null && data.getData() != null) {
            uploadPhoto(data.getData());
        }
    }

    private void uploadPhoto(Uri uri) {
        String fileName = "job-photo.jpg";
        Cursor cursor = getContentResolver().query(uri, null, null, null, null);
        if (cursor != null) {
            try {
                int column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (cursor.moveToFirst() && column >= 0) fileName = cursor.getString(column);
            } finally {
                cursor.close();
            }
        }
        final String uploadName = fileName;
        RequestBody body = new RequestBody() {
            @Override public MediaType contentType() { return MediaType.parse(getContentResolver().getType(uri)); }
            @Override public void writeTo(BufferedSink sink) throws IOException {
                try (java.io.InputStream input = getContentResolver().openInputStream(uri)) {
                    if (input == null) throw new IOException("Unable to open selected photo");
                    byte[] buffer = new byte[8192];
                    int count;
                    while ((count = input.read(buffer)) != -1) sink.write(buffer, 0, count);
                }
            }
        };
        MultipartBody.Part photo = MultipartBody.Part.createFormData("photo", uploadName, body);
        RequestBody description = RequestBody.create("Staff job photo", MediaType.parse("text/plain"));
        api.service().uploadPhoto(jobId, photo, description)
                .enqueue(new Callback<ApiModels.Envelope<Map<String, Object>>>() {
                    @Override public void onResponse(Call<ApiModels.Envelope<Map<String, Object>>> call,
                                                     Response<ApiModels.Envelope<Map<String, Object>>> response) {
                        toast(response.isSuccessful() ? "Photo uploaded." : "Photo upload failed.");
                    }
                    @Override public void onFailure(Call<ApiModels.Envelope<Map<String, Object>>> call, Throwable error) {
                        toast("Unable to upload photo.");
                    }
                });
    }

    private void toast(String message) { Toast.makeText(this, message, Toast.LENGTH_LONG).show(); }
}
