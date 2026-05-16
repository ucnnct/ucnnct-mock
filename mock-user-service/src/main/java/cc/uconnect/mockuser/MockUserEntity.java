package cc.uconnect.mockuser;

final class MockUserEntity {
  private final String id;
  private final String username;
  private final String displayName;
  private final String email;
  private final String password;
  private String leaseId;

  private MockUserEntity(
      String id,
      String username,
      String displayName,
      String email,
      String password
  ) {
    this.id = id;
    this.username = username;
    this.displayName = displayName;
    this.email = email;
    this.password = password;
  }

  static MockUserEntity from(ProvisionedMockUser user) {
    return new MockUserEntity(
        user.id(),
        user.username(),
        user.displayName(),
        user.email(),
        user.password()
    );
  }

  boolean isLeased() {
    return leaseId != null;
  }

  void assignLease(String leaseId) {
    this.leaseId = leaseId;
  }

  void releaseLease() {
    this.leaseId = null;
  }

  String id() {
    return id;
  }

  String username() {
    return username;
  }

  String displayName() {
    return displayName;
  }

  String email() {
    return email;
  }

  String password() {
    return password;
  }

  String leaseId() {
    return leaseId;
  }
}
