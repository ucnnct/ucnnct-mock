package cc.uconnect.mockuser;

import com.fasterxml.jackson.databind.JsonNode;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

final class StagingIdentityUserClient {
  private static final Logger log = LoggerFactory.getLogger(StagingIdentityUserClient.class);

  private final StagingIdentityProperties identityProperties;
  private final StagingIdentityHttpClient http;

  StagingIdentityUserClient(
      StagingIdentityProperties identityProperties,
      StagingIdentityHttpClient http
  ) {
    this.identityProperties = identityProperties;
    this.http = http;
  }

  String fetchUserToken(String username, String password) {
    return StagingIdentityRetry.retry(
        "fetch user token " + username,
        6,
        1_000L,
        () -> fetchUserTokenOnce(username, password)
    );
  }

  void waitForBusinessProfile(String accessToken, String userId) {
    for (int attempt = 1; attempt <= 8; attempt += 1) {
      try {
        HttpRequest request = HttpRequest.newBuilder(identityProperties.targetUsersMeEndpoint())
            .header("Authorization", "Bearer " + accessToken)
            .header("Accept", "application/json")
            .GET()
            .timeout(Duration.ofSeconds(10))
            .build();

        HttpResponse<String> response = http.sendAllowing(
            request,
            List.of(200, 404),
            "verify business profile"
        );
        if (response.statusCode() == 200) {
          return;
        }
      } catch (RuntimeException exception) {
        log.debug("Waiting for business profile sync userId={} attempt={}", userId, attempt, exception);
      }

      sleepBusinessProfileBackoff(userId, attempt);
    }

    throw new IllegalStateException("Business profile did not become available for " + userId);
  }

  private String fetchUserTokenOnce(String username, String password) {
    String body = http.formEncode(
        "grant_type", "password",
        "client_id", identityProperties.clientId(),
        "client_secret", identityProperties.clientSecret(),
        "username", username,
        "password", password,
        "scope", "openid profile email"
    );

    HttpRequest request = http.requestBuilder(identityProperties.realmTokenEndpoint())
        .header("Content-Type", "application/x-www-form-urlencoded")
        .POST(HttpRequest.BodyPublishers.ofString(body))
        .timeout(Duration.ofSeconds(12))
        .build();

    JsonNode json = http.readJson(http.send(request, 200, "password grant for " + username));
    JsonNode accessToken = json.get("access_token");
    if (accessToken == null || accessToken.asText().isBlank()) {
      throw new IllegalStateException("Password grant did not return access_token for " + username);
    }
    return accessToken.asText();
  }

  private void sleepBusinessProfileBackoff(String userId, int attempt) {
    try {
      Thread.sleep(750L * attempt);
    } catch (InterruptedException interruptedException) {
      Thread.currentThread().interrupt();
      throw new IllegalStateException("Interrupted while waiting for business profile sync for " + userId);
    }
  }
}
