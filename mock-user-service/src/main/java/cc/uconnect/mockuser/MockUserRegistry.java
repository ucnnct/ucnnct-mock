package cc.uconnect.mockuser;

import jakarta.annotation.PreDestroy;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.locks.ReentrantLock;
import java.util.concurrent.atomic.AtomicBoolean;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.core.env.Environment;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Service;

@Service
public class MockUserRegistry {
  private static final Logger log = LoggerFactory.getLogger(MockUserRegistry.class);

  private final StagingIdentityProvisioner provisioner;
  private final int initialUserCount;
  private final int targetUserCount;
  private final int expansionBuffer;
  private final int warmupStep;
  private final String defaultPasswordHint;
  private final Map<String, MockUserEntity> users = new LinkedHashMap<>();
  private final Map<String, LeaseEntity> leases = new LinkedHashMap<>();
  private final List<FixtureProfile> fixtures = new ArrayList<>();
  private final ReentrantLock provisioningLock = new ReentrantLock();
  private final ExecutorService warmupExecutor;
  private final AtomicBoolean warmupInProgress = new AtomicBoolean(false);
  private volatile String lastWarmupError;

  public MockUserRegistry(StagingIdentityProvisioner provisioner, Environment environment) {
    this.provisioner = provisioner;
    this.initialUserCount = environment.getProperty("mock.users.initial-count", Integer.class, 64);
    this.targetUserCount = Math.max(
        initialUserCount,
        environment.getProperty("mock.users.target-count", Integer.class, initialUserCount)
    );
    this.expansionBuffer = environment.getProperty("mock.users.expansion-buffer", Integer.class, 24);
    this.warmupStep = environment.getProperty("mock.users.warmup-step", Integer.class, 500);
    this.defaultPasswordHint = environment.getProperty("staging.identity.default-password");
    this.warmupExecutor = Executors.newSingleThreadExecutor(new WarmupThreadFactory());
    if (!provisioner.isEnabled()) {
      throw new IllegalStateException(
          "mock-user-service now requires staging-backed identities. Set STAGING_IDENTITY_PROVISION_ENABLED=true."
      );
    }
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
        targetUserCount,
        totalUsers - leasedUsers,
        leasedUsers,
        activeLeases,
        warmupInProgress.get(),
        lastWarmupError,
        defaultPasswordHint,
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

  public LeaseResponse createLease(LeaseRequest request) {
    if (!"staging".equals(request.environment())) {
      throw new IllegalArgumentException("Only staging is supported by mock-user-service.");
    }

    assertNoActiveLeaseForRun(request.runId());

    ensureAvailableUsers(request.requestedUsers());

    synchronized (this) {
      assertNoActiveLeaseForRun(request.runId());
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
      triggerBackgroundWarmup();

      return new LeaseResponse(
          toLeaseSnapshot(lease),
          assignedUsers.stream().map(this::toLeasedUser).toList()
      );
    }
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
    int desiredTotal;
    synchronized (this) {
      int availableUsers = availableUserCount();
      if (availableUsers >= requestedUsers) {
        return;
      }

      int missingUsers = requestedUsers - availableUsers;
      desiredTotal = Math.max(users.size() + missingUsers, leasedUserCount() + requestedUsers + expansionBuffer);
    }

    synchronizeUsers(desiredTotal);
  }

  private void synchronizeUsers(int desiredTotal) {
    if (desiredTotal <= currentUserCount()) {
      return;
    }

    provisioningLock.lock();
    try {
      int currentCount = currentUserCount();
      if (desiredTotal <= currentCount) {
        return;
      }

      int startIndex = currentCount + 1;
      List<ProvisionedMockUser> provisionedUsers = provisioner.provisionRange(startIndex, desiredTotal);
      synchronized (this) {
        for (ProvisionedMockUser user : provisionedUsers) {
          users.putIfAbsent(user.id(), new MockUserEntity(
              user.id(),
              user.username(),
              user.displayName(),
              user.email(),
              user.password()
          ));
        }
      }
    } finally {
      provisioningLock.unlock();
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

  private synchronized int currentUserCount() {
    return users.size();
  }

  @EventListener(ApplicationReadyEvent.class)
  public void onApplicationReady() {
    triggerBackgroundWarmup();
  }

  @PreDestroy
  public void shutdownWarmupExecutor() {
    warmupExecutor.shutdownNow();
  }

  private void triggerBackgroundWarmup() {
    if (targetUserCount <= currentUserCount()) {
      lastWarmupError = null;
      return;
    }

    if (!warmupInProgress.compareAndSet(false, true)) {
      return;
    }

    warmupExecutor.submit(this::warmToTargetCapacity);
  }

  private void warmToTargetCapacity() {
    long backoffMs = 2_000L;

    try {
      while (!Thread.currentThread().isInterrupted()) {
        int currentCount = currentUserCount();
        if (currentCount >= targetUserCount) {
          lastWarmupError = null;
          return;
        }

        int nextTarget = Math.min(targetUserCount, currentCount + Math.max(1, warmupStep));
        try {
          log.info("Warming mock identity stock from {} to {}", currentCount, nextTarget);
          synchronizeUsers(nextTarget);
          lastWarmupError = null;
          backoffMs = 2_000L;
        } catch (RuntimeException exception) {
          lastWarmupError = exception.getMessage();
          log.warn("Mock identity warmup failed while targeting {} users", nextTarget, exception);
          sleep(backoffMs);
          backoffMs = Math.min(backoffMs * 2L, 30_000L);
        }
      }
    } finally {
      warmupInProgress.set(false);
      if (currentUserCount() < targetUserCount && !Thread.currentThread().isInterrupted()) {
        triggerBackgroundWarmup();
      }
    }
  }

  private synchronized void assertNoActiveLeaseForRun(String runId) {
    leases.values().stream()
        .filter((lease) -> lease.runId.equals(runId) && lease.isActive())
        .findFirst()
        .ifPresent((lease) -> {
          throw new IllegalStateException("An active lease already exists for run " + runId + ".");
        });
  }

  private void sleep(long durationMs) {
    try {
      Thread.sleep(durationMs);
    } catch (InterruptedException exception) {
      Thread.currentThread().interrupt();
      throw new IllegalStateException("Interrupted while warming mock identity stock.", exception);
    }
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

  private static final class WarmupThreadFactory implements ThreadFactory {
    @Override
    public Thread newThread(Runnable runnable) {
      Thread thread = new Thread(runnable, "mock-user-warmup");
      thread.setDaemon(true);
      return thread;
    }
  }
}
