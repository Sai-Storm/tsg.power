package com.gcsms.staff;

import java.util.List;

public final class ApiModels {
    private ApiModels() {}

    public static class Envelope<T> {
        public T data;
        public Meta meta;
    }

    public static class Meta {
        public int page;
        public int per_page;
        public int total;
        public int pages;
    }

    public static class Tokens {
        public String access_token;
        public String refresh_token;
        public String token_type;
        public int expires_in;
    }

    public static class Job {
        public int id;
        public String service_id;
        public String status;
        public String status_label;
        public String complaint;
        public String location;
        public String scheduled_at;
        public Customer customer;
        public Generator generator;

        @Override public String toString() {
            String customerName = customer == null ? "" : customer.name;
            return service_id + "  ·  " + status_label + "\n" + customerName + " — " + complaint;
        }
    }

    public static class Customer {
        public int id;
        public String name;
        public String phone_primary;
        public String address;
        public String city;
    }

    public static class Generator {
        public int id;
        public String brand;
        public String model;
        public String serial_number;
        public String capacity_kva;
    }

    public static class MaterialRequest {
        public String description;
        public String quantity;
        public String unit;
        public String category;
        public String purpose;
    }

    public static class Completion {
        public String diagnosis;
        public String work_performed;
        public String labor_hours;
        public String actual_completion;
        public String completion_remarks;
    }

    public static class HistoryItem {
        public String at;
        public String kind;
        public String title;
        public String detail;
        public String by;
    }

    public static class ApiError {
        public ErrorBody error;
    }

    public static class ErrorBody {
        public String code;
        public String message;
    }
}
