package cc.uconnect.mockuser;

final class MockUserLeaseMapper {
  private MockUserLeaseMapper() {
  }

  static LeaseSnapshot toLeaseSnapshot(LeaseEntity lease) {
    return new LeaseSnapshot(
        lease.id(),
        lease.runId(),
        lease.runName(),
        lease.users(),
        lease.issuedAt().toString(),
        lease.state()
    );
  }

  static LeasedMockUser toLeasedUser(MockUserEntity user) {
    return new LeasedMockUser(
        user.id(),
        user.username(),
        user.displayName(),
        user.email(),
        user.password()
    );
  }
}
