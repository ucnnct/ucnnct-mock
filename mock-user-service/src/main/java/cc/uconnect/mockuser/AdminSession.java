package cc.uconnect.mockuser;

final class AdminSession {
  private String token;
  private long expiresAtMs;

  AdminSession(String token, long expiresAtMs) {
    this.token = token;
    this.expiresAtMs = expiresAtMs;
  }

  String token() {
    return token;
  }

  long expiresAtMs() {
    return expiresAtMs;
  }

  void refreshFrom(AdminSession session) {
    this.token = session.token;
    this.expiresAtMs = session.expiresAtMs;
  }
}
