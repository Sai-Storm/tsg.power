def test_forgot_password_feature_is_removed(client):
    assert client.get("/auth/forgot-password").status_code == 404
    assert client.get("/auth/reset-password").status_code == 404
    assert b"Forgot your password" not in client.get("/auth/login").data
