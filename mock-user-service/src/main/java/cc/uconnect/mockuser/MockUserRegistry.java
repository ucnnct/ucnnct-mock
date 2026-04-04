package cc.uconnect.mockuser;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Service;

@Service
public class MockUserRegistry {
  private final StagingIdentityProvisioner provisioner;
  private final int initialUserCount;
  private final int expansionBuffer;
  private final Map<String, MockUserEntity> users = new LinkedHashMap<>();
  private final Map<String, LeaseEntity> leases = new LinkedHashMap<>();
  private final List<FixtureProfile> fixtures = new ArrayList<>();

  public MockUserRegistry(StagingIdentityProvisioner provisioner, Environment environment) {
    this.provisioner = provisioner;
    this.initialUserCount = environment.getProperty("mock.users.initial-count", Integer.class, 64);
    this.expansionBuffer = environment.getProperty("mock.users.expansion-buffer", Integer.class, 24);
    seedUsers();
    seedFixtures();
  }

  public synchronized MockUserRuntime runtime() {
    int totalUsers = users.size();
    int leasedUsers = leasedUserCount();
    int activeLeases = (int) leases.values().stream().filter(LeaseEntity::isActive).count();

    return new MockUserRuntime(
        "mock-user-service",
        "staging",
        totalUsers,
        totalUsers - leasedUsers,
        leasedUsers,
        activeLeases,
        Instant.now().toString()
    );
  }

  public synchronized List<FixtureProfile> fixtures() {
    return List.copyOf(fixtures);
  }

  public synchronized List<LeaseSnapshot> leases() {
    return leases.values().stream()
        .sorted(Comparator.comparing(LeaseEntity::issuedAt).reversed())
        .map(this::toLeaseSnapshot)
        .toList();
  }

  public synchronized LeaseResponse lease(String leaseId) {
    LeaseEntity lease = leases.get(leaseId);
    if (lease == null) {
      throw new NoSuchElementException("Lease " + leaseId + " was not found.");
    }

    return new LeaseResponse(
        toLeaseSnapshot(lease),
        lease.userIds.stream()
            .map(users::get)
            .filter(java.util.Objects::nonNull)
            .map(this::toLeasedUser)
            .toList()
    );
  }

  public synchronized LeaseResponse createLease(LeaseRequest request) {
    if (!"staging".equals(request.environment())) {
      throw new IllegalArgumentException("Only staging is supported by mock-user-service.");
    }

    leases.values().stream()
        .filter((lease) -> lease.runId.equals(request.runId()) && lease.isActive())
        .findFirst()
        .ifPresent((lease) -> {
          throw new IllegalStateException("An active lease already exists for run " + request.runId() + ".");
        });

    ensureAvailableUsers(request.requestedUsers());
    List<MockUserEntity> assignedUsers = availableUsers(request.requestedUsers());
    if (assignedUsers.size() < request.requestedUsers()) {
      throw new IllegalStateException("Not enough staging-backed mock users are available to satisfy the lease request.");
    }

    String leaseId = "lease-" + java.util.UUID.randomUUID().toString().substring(0, 8);
    Instant issuedAt = Instant.now();
    assignedUsers.forEach((user) -> user.leaseId = leaseId);

    LeaseEntity lease = new LeaseEntity(
        leaseId,
        request.runId(),
        request.runName(),
        request.requestedUsers(),
        assignedUsers.stream().map((user) -> user.id).toList(),
        issuedAt,
        "active"
    );
    leases.put(leaseId, lease);

    return new LeaseResponse(
        toLeaseSnapshot(lease),
        assignedUsers.stream().map(this::toLeasedUser).toList()
    );
  }

  public synchronized LeaseSnapshot releaseLease(String leaseId) {
    LeaseEntity lease = leases.get(leaseId);
    if (lease == null) {
      throw new NoSuchElementException("Lease " + leaseId + " was not found.");
    }

    releaseUsersForLease(lease.id);
    lease.state = "released";
    return toLeaseSnapshot(lease);
  }

  public synchronized LeaseSnapshot releaseRun(String runId) {
    LeaseEntity lease = leases.values().stream()
        .filter((candidate) -> candidate.runId.equals(runId))
        .max(Comparator.comparing(LeaseEntity::issuedAt))
        .orElseThrow(() -> new NoSuchElementException("No lease found for run " + runId + "."));

    releaseUsersForLease(lease.id);
    lease.state = "released";
    return toLeaseSnapshot(lease);
  }

  private void releaseUsersForLease(String leaseId) {
    users.values().stream()
        .filter((user) -> leaseId.equals(user.leaseId))
        .forEach((user) -> user.leaseId = null);
  }

  private void seedUsers() {
    synchronizeUsers(initialUserCount);
  }

  private void ensureAvailableUsers(int requestedUsers) {
    int availableUsers = availableUserCount();
    if (availableUsers >= requestedUsers) {
      return;
    }

    int missingUsers = requestedUsers - availableUsers;
    int desiredTotal = Math.max(users.size() + missingUsers, leasedUserCount() + requestedUsers + expansionBuffer);
    synchronizeUsers(desiredTotal);
  }

  private void synchronizeUsers(int desiredTotal) {
    if (desiredTotal <= users.size()) {
      return;
    }

    int startIndex = users.size() + 1;
    if (provisioner.isEnabled()) {
      List<ProvisionedMockUser> provisionedUsers = provisioner.provisionRange(startIndex, desiredTotal);
      for (ProvisionedMockUser user : provisionedUsers) {
        users.putIfAbsent(user.id(), new MockUserEntity(
            user.id(),
            user.username(),
            user.displayName(),
            user.email(),
            user.password()
        ));
      }
      return;
    }

    for (int index = startIndex; index <= desiredTotal; index += 1) {
      String syntheticId = "synthetic-" + String.format("%04d", index);
      users.putIfAbsent(syntheticId, new MockUserEntity(
          syntheticId,
          buildSyntheticUsername(index),
          "Synthetic Mock User " + index,
          buildSyntheticUsername(index) + "@mock.uconnect.cc",
          null
      ));
    }
  }

  private void seedFixtures() {
    fixtures.add(new FixtureProfile(
        "fixture-campus",
        "Campus graph",
        "Provisioned staging users ready for mixed browse and notification pressure.",
        Math.max(initialUserCount, 32),
        16,
        Math.max(initialUserCount * 3, 96),
        0,
        "ready"
    ));
    fixtures.add(new FixtureProfile(
        "fixture-societies",
        "Societies and clubs",
        "Group-heavy staging identities prepared for group creation and member churn.",
        Math.max(initialUserCount / 2, 24),
        12,
        Math.max(initialUserCount * 2, 64),
        24,
        "ready"
    ));
    fixtures.add(new FixtureProfile(
        "fixture-media",
        "Media playground",
        "Attachment-focused identities used to stress uploads and file-linked messages.",
        Math.max(initialUserCount / 3, 16),
        6,
        Math.max(initialUserCount, 40),
        Math.max(initialUserCount * 2, 80),
        "ready"
    ));
  }

  private List<MockUserEntity> availableUsers(int requestedUsers) {
    return users.values().stream()
        .filter((user) -> !user.isLeased())
        .limit(requestedUsers)
        .toList();
  }

  private int availableUserCount() {
    return (int) users.values().stream().filter((user) -> !user.isLeased()).count();
  }

  private int leasedUserCount() {
    return (int) users.values().stream().filter(MockUserEntity::isLeased).count();
  }

  private String buildSyntheticUsername(int index) {
    return "synthetic.mock.user." + String.format("%03d", index);
  }

  private LeaseSnapshot toLeaseSnapshot(LeaseEntity lease) {
    return new LeaseSnapshot(
        lease.id,
        lease.runId,
        lease.runName,
        lease.users,
        lease.issuedAt.toString(),
        lease.state
    );
  }

  private LeasedMockUser toLeasedUser(MockUserEntity user) {
    return new LeasedMockUser(
        user.id,
        user.username,
        user.displayName,
        user.email,
        user.password
    );
  }

  private static final class MockUserEntity {
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

    private boolean isLeased() {
      return leaseId != null;
    }
  }

  private static final class LeaseEntity {
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

    private boolean isActive() {
      return "active".equals(state);
    }

    private Instant issuedAt() {
      return issuedAt;
    }
  }
}
