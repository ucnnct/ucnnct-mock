package cc.uconnect.mockuser;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import org.springframework.stereotype.Service;

@Service
public class MockUserRegistry {
  private final Map<String, PoolConfig> poolConfigs = new LinkedHashMap<>();
  private final Map<String, MockUserEntity> users = new LinkedHashMap<>();
  private final Map<String, LeaseEntity> leases = new LinkedHashMap<>();
  private final List<FixtureProfile> fixtures = new ArrayList<>();

  public MockUserRegistry(StagingIdentityProvisioner provisioner) {
    seedPools();
    seedUsers(provisioner);
    seedFixtures();
  }

  public synchronized MockUserRuntime runtime() {
    int totalUsers = users.size();
    int leasedUsers = (int) users.values().stream().filter(MockUserEntity::isLeased).count();
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

  public synchronized List<UserPoolSnapshot> pools() {
    return poolConfigs.values().stream()
        .map((pool) -> {
          int total = (int) users.values().stream().filter((user) -> user.poolId.equals(pool.id)).count();
          int leased = (int) users.values().stream()
              .filter((user) -> user.poolId.equals(pool.id) && user.isLeased())
              .count();

          return new UserPoolSnapshot(
              pool.id,
              pool.name,
              pool.purpose,
              total,
              total - leased,
              leased,
              pool.tags,
              pool.notes
          );
        })
        .toList();
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

    PoolConfig selectedPool = pickPool(request.weights());
    List<MockUserEntity> assignedUsers = availableUsersFromPool(selectedPool.id, request.requestedUsers());

    if (assignedUsers.size() < request.requestedUsers()) {
      selectedPool = pools().stream()
          .max(Comparator.comparingInt(UserPoolSnapshot::available))
          .map((snapshot) -> poolConfigs.get(snapshot.id()))
          .orElse(selectedPool);
      assignedUsers = availableUsersFromPool(selectedPool.id, request.requestedUsers());
    }

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
        selectedPool.id,
        selectedPool.name,
        request.requestedUsers(),
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

  private List<MockUserEntity> availableUsersFromPool(String poolId, int requestedUsers) {
    return users.values().stream()
        .filter((user) -> user.poolId.equals(poolId) && !user.isLeased())
        .limit(requestedUsers)
        .toList();
  }

  private PoolConfig pickPool(BehaviorWeights weights) {
    if (weights.media() >= weights.privateMessage() && weights.media() >= weights.group()) {
      return poolConfigs.get("attachment-lab");
    }
    if (weights.group() >= weights.privateMessage()) {
      return poolConfigs.get("community-groups");
    }
    if (weights.privateMessage() >= weights.browse()) {
      return poolConfigs.get("realtime-core");
    }
    return poolConfigs.get("campus-main");
  }

  private void seedPools() {
    registerPool(new PoolConfig(
        "campus-main",
        "Campus Main Pool",
        "Balanced campus-wide activity with broad social graph coverage.",
        12,
        List.of("balanced", "browse", "notifications"),
        "Default pool for mixed realistic runs."
    ));
    registerPool(new PoolConfig(
        "realtime-core",
        "Realtime Core Pool",
        "Dense private messaging and high websocket occupancy.",
        8,
        List.of("realtime", "private-message", "presence"),
        "Preferred when private conversation loops dominate."
    ));
    registerPool(new PoolConfig(
        "community-groups",
        "Community Groups Pool",
        "Pre-seeded members for group-heavy sessions and shared channels.",
        8,
        List.of("groups", "moderation", "community"),
        "Best fit for group resolution and notification stress."
    ));
    registerPool(new PoolConfig(
        "attachment-lab",
        "Attachment Lab Pool",
        "Users with media-friendly fixtures and file metadata ready.",
        4,
        List.of("media", "minio", "attachments"),
        "Reserved for attachment-heavy conversations."
    ));
  }

  private void registerPool(PoolConfig pool) {
    poolConfigs.put(pool.id, pool);
  }

  private void seedUsers(StagingIdentityProvisioner provisioner) {
    List<ProvisionedMockUser> provisionedUsers = provisioner.provision(poolConfigs.values().stream()
        .map((pool) -> new PoolSeedRequest(pool.id, pool.totalUsers, pool.tags))
        .toList());

    if (!provisionedUsers.isEmpty()) {
      provisionedUsers.forEach((user) -> users.put(user.id(), new MockUserEntity(
          user.id(),
          user.username(),
          user.displayName(),
          user.email(),
          user.poolId(),
          user.tags(),
          user.password()
      )));
      return;
    }

    poolConfigs.values().forEach((pool) -> {
      for (int index = 1; index <= pool.totalUsers; index += 1) {
        String syntheticId = pool.id + "-" + String.format("%04d", index);
        String username = "synthetic." + pool.id.replace('-', '.') + "." + index;
        users.put(syntheticId, new MockUserEntity(
            syntheticId,
            username,
            displayName(pool.id, index),
            username + "@mock.uconnect.cc",
            pool.id,
            pool.tags,
            null
        ));
      }
    });
  }

  private void seedFixtures() {
    fixtures.add(new FixtureProfile(
        "fixture-campus",
        "Campus graph",
        "Provisioned staging users ready for mixed browse and notification pressure.",
        12,
        4,
        18,
        0,
        "ready"
    ));
    fixtures.add(new FixtureProfile(
        "fixture-societies",
        "Societies and clubs",
        "Group-heavy staging identities prepared for group creation and member churn.",
        8,
        4,
        10,
        6,
        "ready"
    ));
    fixtures.add(new FixtureProfile(
        "fixture-media",
        "Media playground",
        "Attachment-focused identities used to stress uploads and file-linked messages.",
        4,
        2,
        4,
        12,
        "ready"
    ));
  }

  private String displayName(String poolId, int index) {
    String prefix = switch (poolId) {
      case "realtime-core" -> "Realtime";
      case "community-groups" -> "Community";
      case "attachment-lab" -> "Attachment";
      default -> "Campus";
    };
    return prefix + " Mock " + index;
  }

  private LeaseSnapshot toLeaseSnapshot(LeaseEntity lease) {
    return new LeaseSnapshot(
        lease.id,
        lease.runId,
        lease.runName,
        lease.poolId,
        lease.poolName,
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
        user.poolId,
        user.tags,
        user.password
    );
  }

  private record PoolConfig(
      String id,
      String name,
      String purpose,
      int totalUsers,
      List<String> tags,
      String notes
  ) {
  }

  private static final class MockUserEntity {
    private final String id;
    private final String username;
    private final String displayName;
    private final String email;
    private final String poolId;
    private final List<String> tags;
    private final String password;
    private String leaseId;

    private MockUserEntity(
        String id,
        String username,
        String displayName,
        String email,
        String poolId,
        List<String> tags,
        String password
    ) {
      this.id = id;
      this.username = username;
      this.displayName = displayName;
      this.email = email;
      this.poolId = poolId;
      this.tags = tags;
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
    private final String poolId;
    private final String poolName;
    private final int users;
    private final Instant issuedAt;
    private String state;

    private LeaseEntity(
        String id,
        String runId,
        String runName,
        String poolId,
        String poolName,
        int users,
        Instant issuedAt,
        String state
    ) {
      this.id = id;
      this.runId = runId;
      this.runName = runName;
      this.poolId = poolId;
      this.poolName = poolName;
      this.users = users;
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
