package cc.uconnect.mockuser;

import java.time.Instant;
import java.util.List;

final class LeaseEntity {
  private final String id;
  private final String runId;
  private final String runName;
  private final int users;
  private final List<String> userIds;
  private final Instant issuedAt;
  private String state;

  private LeaseEntity(
      String id,
      String runId,
      String runName,
      int users,
      List<String> userIds,
      Instant issuedAt,
      String state
  ) {
    this.id = id;
    this.runId = runId;
    this.runName = runName;
    this.users = users;
    this.userIds = List.copyOf(userIds);
    this.issuedAt = issuedAt;
    this.state = state;
  }

  static LeaseEntity active(
      String id,
      String runId,
      String runName,
      int users,
      List<String> userIds,
      Instant issuedAt
  ) {
    return new LeaseEntity(id, runId, runName, users, userIds, issuedAt, "active");
  }

  boolean isActive() {
    return "active".equals(state);
  }

  void release() {
    state = "released";
  }

  String id() {
    return id;
  }

  String runId() {
    return runId;
  }

  String runName() {
    return runName;
  }

  int users() {
    return users;
  }

  List<String> userIds() {
    return userIds;
  }

  Instant issuedAt() {
    return issuedAt;
  }

  String state() {
    return state;
  }
}
