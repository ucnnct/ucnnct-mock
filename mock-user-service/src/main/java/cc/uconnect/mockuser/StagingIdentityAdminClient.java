package cc.uconnect.mockuser;

import com.fasterxml.jackson.databind.JsonNode;
import java.net.URI;
import java.net.http.HttpRequest;
import java.time.Duration;
import java.util.concurrent.Callable;

final class StagingIdentityAdminClient {
  private final StagingIdentityProperties identityProperties;
  private final StagingIdentityHttpClient http;

  StagingIdentityAdminClient(
      StagingIdentityProperties identityProperties,
      StagingIdentityHttpClient http
  ) {
    this.identityProperties = identityProperties;
    this.http = http;
  }

  AdminSession fetchSession() {
    return StagingIdentityRetry.retry(
        "fetch admin session",
        8,
        1_500L,
        this::fetchSessionOnce
    );
  }

  JsonNode searchUsers(AdminSession adminSession, String prefix, int first, int max) {
    return withAdminRetry(adminSession, () -> searchUsersOnce(adminSession.token(), prefix, first, max));
  }

  EnsureUserResult ensureUser(AdminSession adminSession, String username, String email, String displayName) {
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
          http.json(username),
          http.json(email),
          http.json(names[0]),
          http.json(names[1])
      );

      HttpRequest request = http.requestBuilder(identityProperties.adminUsersEndpoint())
          .header("Authorization", "Bearer " + adminSession.token())
          .header("Content-Type", "application/json")
          .POST(HttpRequest.BodyPublishers.ofString(payload))
          .timeout(Duration.ofSeconds(12))
          .build();

      http.send(request, 201, "create user " + username);
      JsonNode created = findUserByUsername(adminSession.token(), username);
      if (created == null || created.path("id").asText().isBlank()) {
        throw new IllegalStateException("Unable to resolve Keycloak id after creating " + username);
      }
      return new EnsureUserResult(created.path("id").asText(), true);
    });
  }

  void ensurePassword(AdminSession adminSession, String userId, String password) {
    withAdminRetry(adminSession, () -> {
      String payload = """
          {
            "type": "password",
            "value": "%s",
            "temporary": false
          }
          """.formatted(http.json(password));

      HttpRequest request = http.requestBuilder(identityProperties.adminUserResetPasswordEndpoint(userId))
          .header("Authorization", "Bearer " + adminSession.token())
          .header("Content-Type", "application/json")
          .PUT(HttpRequest.BodyPublishers.ofString(payload))
          .timeout(Duration.ofSeconds(12))
          .build();

      http.send(request, 204, "reset password for " + userId);
      return null;
    });
  }

  private AdminSession fetchSessionOnce() {
    String body = http.formEncode(
        "grant_type", "password",
        "client_id", identityProperties.adminClientId(),
        "username", identityProperties.adminUsername(),
        "password", identityProperties.adminPassword()
    );

    HttpRequest request = http.requestBuilder(identityProperties.adminTokenEndpoint())
        .header("Content-Type", "application/x-www-form-urlencoded")
        .POST(HttpRequest.BodyPublishers.ofString(body))
        .timeout(Duration.ofSeconds(12))
        .build();

    JsonNode json = http.readJson(http.send(request, 200, "admin token"));
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

  private JsonNode findUserByUsername(String adminToken, String username) {
    String query = "?username=" + http.urlEncode(username) + "&exact=true";
    HttpRequest request = http.requestBuilder(
        URI.create(identityProperties.adminUsersEndpoint().toString() + query)
    )
        .header("Authorization", "Bearer " + adminToken)
        .header("Accept", "application/json")
        .GET()
        .timeout(Duration.ofSeconds(12))
        .build();

    JsonNode root = http.readJson(http.send(request, 200, "search user " + username));
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

  private JsonNode searchUsersOnce(String adminToken, String prefix, int first, int max) {
    String query = "?search=" + http.urlEncode(prefix) + "&first=" + first + "&max=" + max;
    HttpRequest request = http.requestBuilder(
        URI.create(identityProperties.adminUsersEndpoint().toString() + query)
    )
        .header("Authorization", "Bearer " + adminToken)
        .header("Accept", "application/json")
        .GET()
        .timeout(Duration.ofSeconds(20))
        .build();

    return http.readJson(http.send(request, 200, "search users by prefix " + prefix));
  }

  private void ensureFreshSession(AdminSession session) {
    if (session.expiresAtMs() - System.currentTimeMillis() <= 10_000L) {
      session.refreshFrom(fetchSession());
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

        initialSession.refreshFrom(fetchSession());
        StagingIdentityRetry.sleep(backoffMs, "admin retry backoff");
        backoffMs = Math.min(backoffMs * 2L, 10_000L);
      } catch (Exception exception) {
        if (attempt == 6) {
          throw new IllegalStateException("Admin operation failed.", exception);
        }
        StagingIdentityRetry.sleep(backoffMs, "admin retry backoff");
        backoffMs = Math.min(backoffMs * 2L, 10_000L);
      }
    }
    throw new IllegalStateException("Admin operation failed after retries.");
  }

  private boolean isRetryableAdminStatus(int statusCode) {
    return statusCode == 401 || StagingIdentityRetry.isRetryableStatus(statusCode);
  }

  private String[] splitDisplayName(String displayName) {
    String[] segments = displayName.split(" ", 2);
    if (segments.length == 1) {
      return new String[]{segments[0], "User"};
    }
    return segments;
  }
}
