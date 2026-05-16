package cc.uconnect.mockuser;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

@Component
public class StagingIdentityProvisioner {
  private static final Logger log = LoggerFactory.getLogger(StagingIdentityProvisioner.class);

  private final StagingIdentityProperties identityProperties;
  private final StagingIdentityAdminClient adminClient;
  private final StagingIdentityUserClient userClient;

  public StagingIdentityProvisioner(ObjectMapper objectMapper, Environment environment) {
    this.identityProperties = new StagingIdentityProperties(environment);
    StagingIdentityHttpClient identityHttp = new StagingIdentityHttpClient(objectMapper, identityProperties);
    this.adminClient = new StagingIdentityAdminClient(identityProperties, identityHttp);
    this.userClient = new StagingIdentityUserClient(identityProperties, identityHttp);
  }

  public boolean isEnabled() {
    return identityProperties.provisionEnabled();
  }

  public List<ProvisionedMockUser> provisionRange(int fromIndex, int toIndex) {
    if (!isEnabled() || toIndex < fromIndex) {
      return List.of();
    }

    String defaultPassword = identityProperties.defaultPassword();
    boolean verifyCreatedUsers = identityProperties.verifyCreatedUsers();
    int concurrency = identityProperties.provisionConcurrency();
    int batchSize = identityProperties.provisionBatchSize();
    ExecutorService executor = Executors.newFixedThreadPool(Math.max(1, concurrency));

    try {
      List<Future<List<ProvisionedMockUser>>> futures = submitProvisioningBatches(
          executor,
          fromIndex,
          toIndex,
          batchSize,
          defaultPassword,
          verifyCreatedUsers
      );
      List<ProvisionedMockUser> users = collectProvisionedUsers(futures, toIndex - fromIndex + 1);
      log.info("Provisioned {} staging-backed mock identities", users.size());
      return users;
    } finally {
      executor.shutdownNow();
    }
  }

  public List<ProvisionedMockUser> discoverExistingUsers(int upToIndex) {
    if (!isEnabled() || upToIndex < 1) {
      return List.of();
    }

    String defaultPassword = identityProperties.defaultPassword();
    String prefix = identityProperties.usernamePrefix();
    String usernamePrefix = identityProperties.usernameSearchPrefix();
    AdminSession adminSession = adminClient.fetchSession();
    Map<Integer, ProvisionedMockUser> discoveredUsers = new LinkedHashMap<>();
    int pageSize = 500;

    for (int first = 0; first <= upToIndex + pageSize; first += pageSize) {
      JsonNode page = adminClient.searchUsers(adminSession, prefix, first, pageSize);
      if (!page.isArray() || page.isEmpty()) {
        break;
      }

      collectDiscoveredUsers(page, upToIndex, usernamePrefix, defaultPassword, discoveredUsers);
      if (page.size() < pageSize) {
        break;
      }
    }

    List<ProvisionedMockUser> users = sortedUsers(discoveredUsers.values());
    log.info("Discovered {} existing staging-backed mock identities", users.size());
    return users;
  }

  private List<Future<List<ProvisionedMockUser>>> submitProvisioningBatches(
      ExecutorService executor,
      int fromIndex,
      int toIndex,
      int batchSize,
      String defaultPassword,
      boolean verifyCreatedUsers
  ) {
    List<Future<List<ProvisionedMockUser>>> futures = new ArrayList<>();
    for (int batchStart = fromIndex; batchStart <= toIndex; batchStart += batchSize) {
      int currentBatchStart = batchStart;
      int batchEnd = Math.min(toIndex, batchStart + batchSize - 1);
      futures.add(executor.submit(() ->
          provisionBatch(currentBatchStart, batchEnd, defaultPassword, verifyCreatedUsers)
      ));
    }
    return futures;
  }

  private List<ProvisionedMockUser> collectProvisionedUsers(
      List<Future<List<ProvisionedMockUser>>> futures,
      int expectedCount
  ) {
    List<ProvisionedMockUser> provisionedUsers = new ArrayList<>(expectedCount);
    try {
      for (Future<List<ProvisionedMockUser>> future : futures) {
        provisionedUsers.addAll(future.get());
      }
    } catch (InterruptedException exception) {
      Thread.currentThread().interrupt();
      throw new IllegalStateException("Interrupted while provisioning staging-backed identities.", exception);
    } catch (ExecutionException exception) {
      throw unwrapProvisioningFailure(exception);
    }
    return sortedUsers(provisionedUsers);
  }

  private List<ProvisionedMockUser> provisionBatch(
      int fromIndex,
      int toIndex,
      String defaultPassword,
      boolean verifyCreatedUsers
  ) {
    AdminSession adminSession = adminClient.fetchSession();
    List<ProvisionedMockUser> batch = new ArrayList<>(toIndex - fromIndex + 1);

    for (int index = fromIndex; index <= toIndex; index += 1) {
      String username = identityProperties.buildUsername(index);
      String email = username + "@mock.uconnect.cc";
      String displayName = identityProperties.buildDisplayName(index);
      EnsureUserResult user = adminClient.ensureUser(adminSession, username, email, displayName);

      adminClient.ensurePassword(adminSession, user.userId(), defaultPassword);
      if (user.created() && verifyCreatedUsers) {
        String accessToken = userClient.fetchUserToken(username, defaultPassword);
        userClient.waitForBusinessProfile(accessToken, user.userId());
      }

      batch.add(new ProvisionedMockUser(
          user.userId(),
          username,
          displayName,
          email,
          defaultPassword
      ));
    }

    return batch;
  }

  private void collectDiscoveredUsers(
      JsonNode page,
      int upToIndex,
      String usernamePrefix,
      String defaultPassword,
      Map<Integer, ProvisionedMockUser> discoveredUsers
  ) {
    for (JsonNode candidate : page) {
      String username = candidate.path("username").asText();
      if (!username.startsWith(usernamePrefix)) {
        continue;
      }

      int index = identityProperties.parseUsernameIndex(username);
      if (index < 1 || index > upToIndex) {
        continue;
      }

      ProvisionedMockUser user = toProvisionedUser(candidate, index, defaultPassword);
      if (user != null) {
        discoveredUsers.put(index, user);
      }
    }
  }

  private ProvisionedMockUser toProvisionedUser(JsonNode candidate, int index, String defaultPassword) {
    String username = candidate.path("username").asText();
    String userId = candidate.path("id").asText();
    if (userId == null || userId.isBlank()) {
      return null;
    }

    String firstName = candidate.path("firstName").asText("");
    String lastName = candidate.path("lastName").asText("");
    String displayName = (firstName + " " + lastName).trim();
    if (displayName.isBlank()) {
      displayName = identityProperties.buildDisplayName(index);
    }

    String email = candidate.path("email").asText(username + "@mock.uconnect.cc");
    return new ProvisionedMockUser(userId, username, displayName, email, defaultPassword);
  }

  private List<ProvisionedMockUser> sortedUsers(Iterable<ProvisionedMockUser> users) {
    List<ProvisionedMockUser> sorted = new ArrayList<>();
    users.forEach(sorted::add);
    sorted.sort(Comparator.comparing(ProvisionedMockUser::username));
    return sorted;
  }

  private IllegalStateException unwrapProvisioningFailure(ExecutionException exception) {
    Throwable cause = exception.getCause();
    if (cause instanceof IllegalStateException illegalStateException) {
      return illegalStateException;
    }
    return new IllegalStateException("Provisioning failed.", cause);
  }
}
