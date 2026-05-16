package cc.uconnect.mockuser;

import jakarta.annotation.PreDestroy;
import java.time.Instant;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
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
  private final List<FixtureProfile> fixtures;
  private final ReentrantLock provisioningLock = new ReentrantLock(true);
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
    this.fixtures = MockUserFixtures.build(initialUserCount);
    this.warmupExecutor = Executors.newSingleThreadExecutor(new WarmupThreadFactory());
    if (!provisioner.isEnabled()) {
      throw new IllegalStateException(
          "mock-user-service now requires staging-backed identities. Set STAGING_IDENTITY_PROVISION_ENABLED=true."
      );
    }
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
        .map(MockUserLeaseMapper::toLeaseSnapshot)
        .toList();
  }

  public synchronized LeaseResponse lease(String leaseId) {
    LeaseEntity lease = leases.get(leaseId);
    if (lease == null) {
      throw new NoSuchElementException("Lease " + leaseId + " was not found.");
    }

    return new LeaseResponse(
        MockUserLeaseMapper.toLeaseSnapshot(lease),
        lease.userIds().stream()
            .map(users::get)
            .filter(java.util.Objects::nonNull)
            .map(MockUserLeaseMapper::toLeasedUser)
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
      assignedUsers.forEach((user) -> user.assignLease(leaseId));

      LeaseEntity lease = LeaseEntity.active(
          leaseId,
          request.runId(),
          request.runName(),
          request.requestedUsers(),
          assignedUsers.stream().map(MockUserEntity::id).toList(),
          issuedAt
      );
      leases.put(leaseId, lease);
      triggerBackgroundWarmup();

      return new LeaseResponse(
          MockUserLeaseMapper.toLeaseSnapshot(lease),
          assignedUsers.stream().map(MockUserLeaseMapper::toLeasedUser).toList()
      );
    }
  }

  public synchronized LeaseSnapshot releaseLease(String leaseId) {
    LeaseEntity lease = leases.get(leaseId);
    if (lease == null) {
      throw new NoSuchElementException("Lease " + leaseId + " was not found.");
    }

    releaseUsersForLease(lease.id());
    lease.release();
    return MockUserLeaseMapper.toLeaseSnapshot(lease);
  }

  public synchronized LeaseSnapshot releaseRun(String runId) {
    LeaseEntity lease = leases.values().stream()
        .filter((candidate) -> candidate.runId().equals(runId))
        .max(Comparator.comparing(LeaseEntity::issuedAt))
        .orElseThrow(() -> new NoSuchElementException("No lease found for run " + runId + "."));

    releaseUsersForLease(lease.id());
    lease.release();
    return MockUserLeaseMapper.toLeaseSnapshot(lease);
  }

  private void releaseUsersForLease(String leaseId) {
    users.values().stream()
        .filter((user) -> leaseId.equals(user.leaseId()))
        .forEach(MockUserEntity::releaseLease);
  }

  private void ensureAvailableUsers(int requestedUsers) {
    hydrateExistingUsersIfNeeded();

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
          users.putIfAbsent(user.id(), MockUserEntity.from(user));
        }
      }
    } finally {
      provisioningLock.unlock();
    }
  }

  private void hydrateExistingUsersIfNeeded() {
    if (currentUserCount() > 0) {
      return;
    }

    provisioningLock.lock();
    try {
      if (currentUserCount() > 0) {
        return;
      }

      List<ProvisionedMockUser> discoveredUsers = provisioner.discoverExistingUsers(targetUserCount);
      synchronized (this) {
        for (ProvisionedMockUser user : discoveredUsers) {
          users.putIfAbsent(user.id(), MockUserEntity.from(user));
        }
      }
    } finally {
      provisioningLock.unlock();
    }
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
      hydrateExistingUsersIfNeeded();
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
          sleep(250L);
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
        .filter((lease) -> lease.runId().equals(runId) && lease.isActive())
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

}
