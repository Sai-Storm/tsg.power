package com.gcsms.staff;

import java.util.List;
import java.util.Map;

import okhttp3.MultipartBody;
import okhttp3.RequestBody;
import retrofit2.Call;
import retrofit2.http.Body;
import retrofit2.http.GET;
import retrofit2.http.Multipart;
import retrofit2.http.POST;
import retrofit2.http.Part;
import retrofit2.http.Path;
import retrofit2.http.Query;

public interface ApiService {
    @POST("auth/login")
    Call<ApiModels.Envelope<ApiModels.Tokens>> login(@Body Map<String, String> body);

    @POST("auth/refresh")
    Call<ApiModels.Envelope<ApiModels.Tokens>> refresh(@Body Map<String, String> body);

    @POST("auth/logout")
    Call<ApiModels.Envelope<Map<String, Boolean>>> logout();

    @GET("jobs")
    Call<ApiModels.Envelope<List<ApiModels.Job>>> jobs(@Query("page") int page,
                                                       @Query("per_page") int perPage);

    @GET("jobs/{id}")
    Call<ApiModels.Envelope<ApiModels.Job>> job(@Path("id") int id);

    @GET("jobs/{id}/history")
    Call<ApiModels.Envelope<List<ApiModels.HistoryItem>>> history(@Path("id") int id);

    @GET("jobs/{id}/materials")
    Call<ApiModels.Envelope<List<Map<String, Object>>>> materials(@Path("id") int id);

    @POST("jobs/{id}/materials")
    Call<ApiModels.Envelope<Map<String, Object>>> addMaterial(@Path("id") int id,
                                                               @Body ApiModels.MaterialRequest body);

    @POST("jobs/{id}/materials/submit")
    Call<ApiModels.Envelope<List<Map<String, Object>>>> submitMaterials(@Path("id") int id);

    @POST("jobs/{id}/completion")
    Call<ApiModels.Envelope<ApiModels.Job>> complete(@Path("id") int id,
                                                      @Body ApiModels.Completion body);

    @Multipart
    @POST("jobs/{id}/photos")
    Call<ApiModels.Envelope<Map<String, Object>>> uploadPhoto(@Path("id") int id,
                                                               @Part MultipartBody.Part photo,
                                                               @Part("description") RequestBody description);
}
