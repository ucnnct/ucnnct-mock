package cc.uconnect.mockuser;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.Callable;
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

  private final ObjectMapper objectMapper;
  private final HttpClient httpClient;
  private final Environment environment;

  public StagingIdentityProvisioner(ObjectMapper objectMapper, Environment environment) {
    this.objectMapper = objectMapper;
    this.environment = environment;
    this.httpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .followRedirects(HttpClient.Redirect.NORMAL)
        .build();
  }

  public boolean isEnabled() {
    return environment.getProperty("staging.identity.provision-enabled", Boolean.class, false);
  }

  public List<ProvisionedMockUser> provisionRange(int fromIndex, int toIndex) {
    if (!isEnabled()) {
      return List.of();
    }
    if (toIndex < fromIndex) {
      return List.of();
    }

    String defaultPassword = required("staging.identity.default-password");
    int concurrency = environment.getProperty("mock.users.provision-concurrency", Integer.class, 16);
    int batchSize = environment.getProperty("mock.users.provision-batch-size", Integer.class, 40);
    List<ProvisionedMockUser> provisionedUsers = new ArrayList<>(toIndex - fromIndex + 1);
    ExecutorService executor = Executors.newFixedThreadPool(Math.max(1, concurrency));
    List<Future<List<ProvisionedMockUser>>> futures = new ArrayList<>();

    for (int batchStart = fromIndex; batchStart <= toIndex; batchStart += batchSize) {
      int currentBatchStart = batchStart;
      int batchEnd = Math.min(toIndex, batchStart + batchSize - 1);
      futures.add(executor.submit(() -> provisionBatch(currentBatchStart, batchEnd, defaultPassword)));
    }

    try {
      for (Future<List<ProvisionedMockUser>> future : futures) {
        provisionedUsers.addAll(future.get());
      }
    } catch (InterruptedException exception) {
      Thread.currentThread().interrupt();
      throw new IllegalStateException("Interrupted while provisioning staging-backed identities.", exception);
    } catch (ExecutionException exception) {
      throw unwrapProvisioningFailure(exception);
    } finally {
      executor.shutdownNow();
    }

    provisionedUsers.sort(Comparator.comparing(ProvisionedMockUser::username));
    log.info("Provisioned {} staging-backed mock identities", provisionedUsers.size());
    return provisionedUsers;
  }

  private List<ProvisionedMockUser> provisionBatch(int fromIndex, int toIndex, String defaultPassword) {
    AdminSession adminSession = fetchAdminSession();
    List<ProvisionedMockUser> batch = new ArrayList<>(toIndex - fromIndex + 1);

    for (int index = fromIndex; index <= toIndex; index += 1) {
      String username = buildUsername(index);
      String email = username + "@mock.uconnect.cc";
      String displayName = buildDisplayName(index);

      EnsureUserResult user = ensureUser(adminSession, username, email, displayName);
      ensurePassword(adminSession, user.userId(), defaultPassword);
      if (user.created()) {
        String accessToken = fetchUserToken(username, defaultPassword);
        waitForBusinessProfile(accessToken, user.userId());
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

  private AdminSession fetchAdminSession() {
    return retry(
        "fetch admin session",
        8,
        1_500L,
        this::fetchAdminSessionOnce
    );
  }

  private AdminSession fetchAdminSessionOnce() {
    String body = formEncode(
        "grant_type", "password",
        "client_id", required("staging.identity.admin-client-id"),
        "username", required("staging.identity.admin-username"),
        "password", required("staging.identity.admin-password")
    );

    HttpRequest request = HttpRequest.newBuilder(adminTokenEndpoint())
        .header("Content-Type", "application/x-www-form-urlencoded")
        .POST(HttpRequest.BodyPublishers.ofString(body))
        .timeout(Duration.ofSeconds(12))
        .build();

    JsonNode json = readJson(send(request, 200, "admin token"));
    JsonNode accessToken = json.get("access_token");
    if (accessToken == null || accessToken.asText().isBlank()) {
      throw new IllegalStateException("Keycloak admin token response did not contain access_token.");
    }
    long expiresInSeconds = json.path("expires_in").asLong(60L);
    return new AdminSession(
        accessToken.asText(),
        System.currentTimeMillis() + Math.max(15_000L, (expiresInSeconds - 5L) * 1_000L)
    );
  }

  private EnsureUserResult ensureUser(AdminSession adminSession, String username, String email, String displayName) {
    return withAdminRetry(adminSession, () -> {
      JsonNode existing = findUserByUsername(adminSession.token(), username);
      if (existing != null) {
        String existingId = existing.path("id").asText();
        if (existingId == null || existingId.isBlank()) {
          throw new IllegalStateException("Existing Keycloak user is missing id for username " + username);
        }
        return new EnsureUserResult(existingId, false);
      }

      String[] names = splitDisplayName(displayName);
      String payload = """
          {
            "username": "%s",
            "email": "%s",
            "enabled": true,
            "emailVerified": true,
            "firstName": "%s",
            "lastName": "%s"
          }
          """.formatted(
          json(username),
          json(email),
          json(names[0]),
          json(names[1])
      );

      HttpRequest request = HttpRequest.newBuilder(adminUsersEndpoint())
          .header("Authorization", "Bearer " + adminSession.token())
          .header("Content-Type", "application/json")
          .POST(HttpRequest.BodyPublishers.ofString(payload))
          .timeout(Duration.ofSeconds(12))
          .build();

      send(request, 201, "create user " + username);
      JsonNode created = findUserByUsername(adminSession.token(), username);
      if (created == null || created.path("id").asText().isBlank()) {
        throw new IllegalStateException("Unable to resolve Keycloak id after creating " + username);
      }
      return new EnsureUserResult(created.path("id").asText(), true);
    });
  }

  private void ensurePassword(AdminSession adminSession, String userId, String password) {
    withAdminRetry(adminSession, () -> {
      String payload = """
          {
            "type": "password",
            "value": "%s",
            "temporary": false
          }
          """.formatted(json(password));

      HttpRequest request = HttpRequest.newBuilder(adminUserResetPasswordEndpoint(userId))
          .header("Authorization", "Bearer " + adminSession.token())
          .header("Content-Type", "application/json")
          .PUT(HttpRequest.BodyPublishers.ofString(payload))
          .timeout(Duration.ofSeconds(12))
          .build();

      send(request, 204, "reset password for " + userId);
      return null;
    });
  }

  private String fetchUserToken(String username, String password) {
    return retry(
        "fetch user token " + username,
        6,
        1_000L,
        () -> fetchUserTokenOnce(username, password)
    );
  }

  private String fetchUserTokenOnce(String username, String password) {
    String body = formEncode(
        "grant_type", "password",
        "client_id", required("staging.identity.client-id"),
        "client_secret", required("staging.identity.client-secret"),
        "username", username,
        "password", password,
        "scope", "openid profile email"
    );

    HttpRequest request = HttpRequest.newBuilder(realmTokenEndpoint())
        .header("Content-Type", "application/x-www-form-urlencoded")
        .POST(HttpRequest.BodyPublishers.ofString(body))
        .timeout(Duration.ofSeconds(12))
        .build();

    JsonNode json = readJson(send(request, 200, "password grant for " + username));
    JsonNode accessToken = json.get("access_token");
    if (accessToken == null || accessToken.asText().isBlank()) {
      throw new IllegalStateException("Password grant did not return access_token for " + username);
    }
    return accessToken.asText();
  }

  private void waitForBusinessProfile(String accessToken, String userId) {
    for (int attempt = 1; attempt <= 8; attempt += 1) {
      try {
        HttpRequest request = HttpRequest.newBuilder(targetUsersMeEndpoint())
            .header("Authorization", "Bearer " + accessToken)
            .header("Accept", "application/json")
            .GET()
            .timeout(Duration.ofSeconds(10))
            .build();

        HttpResponse<String> response = sendAllowing(request, List.of(200, 404), "verify business profile");
        if (response.statusCode() == 200) {
          return;
        }
      } catch (RuntimeException exception) {
        log.debug("Waiting for business profile sync userId={} attempt={}", userId, attempt, exception);
      }

      try {
        Thread.sleep(750L * attempt);
      } catch (InterruptedException interruptedException) {
        Thread.currentThread().interrupt();
        throw new IllegalStateException("Interrupted while waiting for business profile sync for " + userId);
      }
    }

    throw new IllegalStateException("Business profile did not become available for " + userId);
  }

  private JsonNode findUserByUsername(String adminToken, String username) {
    String query = "?username=" + urlEncode(username) + "&exact=true";
    HttpRequest request = HttpRequest.newBuilder(URI.create(adminUsersEndpoint().toString() + query))
        .header("Authorization", "Bearer " + adminToken)
        .header("Accept", "application/json")
        .GET()
        .timeout(Duration.ofSeconds(12))
        .build();

    JsonNode root = readJson(send(request, 200, "search user " + username));
    if (!root.isArray()) {
      return null;
    }

    for (JsonNode candidate : root) {
      if (username.equals(candidate.path("username").asText())) {
        return candidate;
      }
    }
    return null;
  }

  private HttpResponse<String> send(HttpRequest request, int expectedStatus, String context) {
    HttpResponse<String> response = sendAllowing(request, List.of(expectedStatus), context);
    if (response.statusCode() != expectedStatus) {
      throw new IllegalStateException("Unexpected status for " + context + ": " + response.statusCode());
    }
    return response;
  }

  private HttpResponse<String> sendAllowing(HttpRequest request, List<Integer> allowedStatuses, String context) {
    try {
      HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
      if (!allowedStatuses.contains(response.statusCode())) {
        throw new UnexpectedHttpStatusException(
            response.statusCode(),
            "Unexpected status for " + context + ": " + response.statusCode() + " body=" + response.body()
        );
      }
      return response;
    } catch (InterruptedException exception) {
      Thread.currentThread().interrupt();
      throw new IllegalStateException("HTTP call failed for " + context, exception);
    } catch (IOException exception) {
      throw new IllegalStateException("HTTP call failed for " + context, exception);
    }
  }

  private JsonNode readJson(HttpResponse<String> response) {
    try {
      return objectMapper.readTree(response.body());
    } catch (IOException exception) {
      throw new IllegalStateException("Failed to parse JSON response body: " + response.body(), exception);
    }
  }

  private URI adminTokenEndpoint() {
    return URI.create(required("staging.identity.base-url") + "/realms/master/protocol/openid-connect/token");
  }

  private URI realmTokenEndpoint() {
    return URI.create(required("staging.identity.base-url") + "/realms/" + realm() + "/protocol/openid-connect/token");
  }

  private URI adminUsersEndpoint() {
    return URI.create(required("staging.identity.base-url") + "/admin/realms/" + realm() + "/users");
  }

  private URI adminUserResetPasswordEndpoint(String userId) {
    return URI.create(adminUsersEndpoint().toString() + "/" + userId + "/reset-password");
  }

  private URI targetUsersMeEndpoint() {
    return URI.create(required("staging.identity.target-base-url") + "/api/users/me");
  }

  private String realm() {
    return required("staging.identity.realm");
  }

  private String buildUsername(int index) {
    String prefix = environment.getProperty("staging.identity.username-prefix", "mock.staging.user");
    return prefix + "." + String.format("%03d", index);
  }

  private String buildDisplayName(int index) {
    return "Mock User " + index;
  }

  private String[] splitDisplayName(String displayName) {
    String[] segments = displayName.split(" ", 2);
    if (segments.length == 1) {
      return new String[]{segments[0], "User"};
    }
    return segments;
  }

  private String required(String key) {
    String value = environment.getProperty(key);
    if (value == null || value.isBlank()) {
      throw new IllegalStateException("Missing required property " + key);
    }
    return value;
  }

  private String formEncode(String... entries) {
    List<String> parts = new ArrayList<>();
    for (int index = 0; index < entries.length; index += 2) {
      parts.add(urlEncode(entries[index]) + "=" + urlEncode(entries[index + 1]));
    }
    return String.join("&", parts);
  }

  private String urlEncode(String raw) {
    return URLEncoder.encode(raw, StandardCharsets.UTF_8);
  }

  private String json(String raw) {
    return raw
        .replace("\\", "\\\\")
        .replace("\"", "\\\"");
  }

  private void ensureFreshSession(AdminSession session) {
    if (session.expiresAtMs() - System.currentTimeMillis() <= 10_000L) {
      AdminSession refreshed = fetchAdminSession();
      session.token = refreshed.token;
      session.expiresAtMs = refreshed.expiresAtMs;
    }
  }

  private <T> T withAdminRetry(AdminSession initialSession, Callable<T> operation) {
    long backoffMs = 1_000L;
    for (int attempt = 1; attempt <= 6; attempt += 1) {
      ensureFreshSession(initialSession);
      try {
        return operation.call();
      } catch (UnexpectedHttpStatusException exception) {
        if (!isRetryableAdminStatus(exception.statusCode()) || attempt == 6) {
          throw exception;
        }

        AdminSession session = fetchAdminSession();
        initialSession.token = session.token;
        initialSession.expiresAtMs = session.expiresAtMs;
        sleep(backoffMs, "admin retry backoff");
        backoffMs = Math.min(backoffMs * 2L, 10_000L);
      } catch (Exception exception) {
        if (attempt == 6) {
          throw new IllegalStateException("Admin operation failed.", exception);
        }
        sleep(backoffMs, "admin retry backoff");
        backoffMs = Math.min(backoffMs * 2L, 10_000L);
      }
    }
    throw new IllegalStateException("Admin operation failed after retries.");
  }

  private IllegalStateException unwrapProvisioningFailure(ExecutionException exception) {
    Throwable cause = exception.getCause();
    if (cause instanceof IllegalStateException illegalStateException) {
      return illegalStateException;
    }
    return new IllegalStateException("Provisioning failed.", cause);
  }

  private <T> T retry(String context, int maxAttempts, long initialDelayMs, Callable<T> operation) {
    long backoffMs = initialDelayMs;
    for (int attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return operation.call();
      } catch (UnexpectedHttpStatusException exception) {
        if (!isRetryableStatus(exception.statusCode()) || attempt == maxAttempts) {
          throw exception;
        }
        log.warn(
            "Retrying {} after transient status {} (attempt {}/{})",
            context,
            exception.statusCode(),
            attempt,
            maxAttempts
        );
      } catch (Exception exception) {
        if (attempt == maxAttempts) {
          throw new IllegalStateException("Operation failed for " + context, exception);
        }
        log.warn(
            "Retrying {} after transient failure (attempt {}/{})",
            context,
            attempt,
            maxAttempts,
            exception
        );
      }

      sleep(backoffMs, context + " retry backoff");
      backoffMs = Math.min(backoffMs * 2L, 15_000L);
    }
    throw new IllegalStateException("Operation failed for " + context);
  }

  private boolean isRetryableStatus(int statusCode) {
    return statusCode == 429 || (statusCode >= 500 && statusCode <= 504);
  }

  private boolean isRetryableAdminStatus(int statusCode) {
    return statusCode == 401 || isRetryableStatus(statusCode);
  }

  private void sleep(long durationMs, String context) {
    try {
      Thread.sleep(durationMs);
    } catch (InterruptedException exception) {
      Thread.currentThread().interrupt();
      throw new IllegalStateException("Interrupted during " + context, exception);
    }
  }
}

final class AdminSession {
  String token;
  long expiresAtMs;

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
}

record EnsureUserResult(String userId, boolean created) {
}

final class UnexpectedHttpStatusException extends IllegalStateException {
  private final int statusCode;

  UnexpectedHttpStatusException(int statusCode, String message) {
    super(message);
    this.statusCode = statusCode;
  }

  int statusCode() {
    return statusCode;
  }
}

record ProvisionedMockUser(
    String id,
    String username,
    String displayName,
    String email,
    String password
) {
}
