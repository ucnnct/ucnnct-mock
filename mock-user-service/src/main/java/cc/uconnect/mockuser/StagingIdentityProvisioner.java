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
import java.util.List;
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

  public List<ProvisionedMockUser> provision(List<PoolSeedRequest> pools) {
    if (!isEnabled()) {
      return List.of();
    }

    String adminToken = fetchAdminToken();
    String defaultPassword = required("staging.identity.default-password");
    List<ProvisionedMockUser> provisionedUsers = new ArrayList<>();

    for (PoolSeedRequest pool : pools) {
      for (int index = 1; index <= pool.totalUsers(); index += 1) {
        String username = buildUsername(pool.id(), index);
        String email = username + "@mock.uconnect.cc";
        String displayName = buildDisplayName(pool.id(), index);

        String userId = ensureUser(adminToken, username, email, displayName);
        ensurePassword(adminToken, userId, defaultPassword);
        String accessToken = fetchUserToken(username, defaultPassword);
        waitForBusinessProfile(accessToken, userId);

        provisionedUsers.add(new ProvisionedMockUser(
            userId,
            username,
            displayName,
            email,
            pool.id(),
            pool.tags(),
            defaultPassword
        ));
      }
    }

    log.info("Provisioned {} staging-backed mock identities", provisionedUsers.size());
    return provisionedUsers;
  }

  private String fetchAdminToken() {
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
    return accessToken.asText();
  }

  private String ensureUser(String adminToken, String username, String email, String displayName) {
    JsonNode existing = findUserByUsername(adminToken, username);
    if (existing != null) {
      String existingId = existing.path("id").asText();
      if (existingId == null || existingId.isBlank()) {
        throw new IllegalStateException("Existing Keycloak user is missing id for username " + username);
      }
      return existingId;
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
        .header("Authorization", "Bearer " + adminToken)
        .header("Content-Type", "application/json")
        .POST(HttpRequest.BodyPublishers.ofString(payload))
        .timeout(Duration.ofSeconds(12))
        .build();

    send(request, 201, "create user " + username);
    JsonNode created = findUserByUsername(adminToken, username);
    if (created == null || created.path("id").asText().isBlank()) {
      throw new IllegalStateException("Unable to resolve Keycloak id after creating " + username);
    }
    return created.path("id").asText();
  }

  private void ensurePassword(String adminToken, String userId, String password) {
    String payload = """
        {
          "type": "password",
          "value": "%s",
          "temporary": false
        }
        """.formatted(json(password));

    HttpRequest request = HttpRequest.newBuilder(adminUserResetPasswordEndpoint(userId))
        .header("Authorization", "Bearer " + adminToken)
        .header("Content-Type", "application/json")
        .PUT(HttpRequest.BodyPublishers.ofString(payload))
        .timeout(Duration.ofSeconds(12))
        .build();

    send(request, 204, "reset password for " + userId);
  }

  private String fetchUserToken(String username, String password) {
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
        throw new IllegalStateException(
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

  private String buildUsername(String poolId, int index) {
    String prefix = environment.getProperty("staging.identity.username-prefix", "mock.staging");
    return prefix + "." + poolId.replace('-', '.') + "." + String.format("%03d", index);
  }

  private String buildDisplayName(String poolId, int index) {
    String label = switch (poolId) {
      case "realtime-core" -> "Realtime";
      case "community-groups" -> "Community";
      case "attachment-lab" -> "Attachment";
      default -> "Campus";
    };
    return label + " Mock " + index;
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
}

record PoolSeedRequest(
    String id,
    int totalUsers,
    List<String> tags
) {
}

record ProvisionedMockUser(
    String id,
    String username,
    String displayName,
    String email,
    String poolId,
    List<String> tags,
    String password
) {
}
