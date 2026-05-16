package cc.uconnect.mockuser;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.net.CookieManager;
import java.net.CookiePolicy;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

final class StagingIdentityHttpClient {
  private final ObjectMapper objectMapper;
  private final StagingIdentityProperties identityProperties;
  private final HttpClient httpClient;
  private final CookieManager cookieManager;

  StagingIdentityHttpClient(ObjectMapper objectMapper, StagingIdentityProperties identityProperties) {
    this.objectMapper = objectMapper;
    this.identityProperties = identityProperties;
    this.cookieManager = new CookieManager(null, CookiePolicy.ACCEPT_ALL);
    this.httpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .cookieHandler(cookieManager)
        .followRedirects(HttpClient.Redirect.NORMAL)
        .build();
  }

  HttpRequest.Builder requestBuilder(URI uri) {
    HttpRequest.Builder builder = HttpRequest.newBuilder(uri);
    String hostHeader = identityProperties.hostHeader();
    if (hostHeader != null && !hostHeader.isBlank()) {
      builder.header("Host", hostHeader);
    }
    return builder;
  }

  JsonNode readJson(HttpResponse<String> response) {
    try {
      return objectMapper.readTree(response.body());
    } catch (IOException exception) {
      throw new IllegalStateException("Failed to parse JSON response body: " + response.body(), exception);
    }
  }

  HttpResponse<String> send(HttpRequest request, int expectedStatus, String context) {
    HttpResponse<String> response = sendAllowing(request, List.of(expectedStatus), context);
    if (response.statusCode() != expectedStatus) {
      throw new IllegalStateException("Unexpected status for " + context + ": " + response.statusCode());
    }
    return response;
  }

  HttpResponse<String> sendAllowing(HttpRequest request, List<Integer> allowedStatuses, String context) {
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

  String formEncode(String... entries) {
    List<String> parts = new ArrayList<>();
    for (int index = 0; index < entries.length; index += 2) {
      parts.add(urlEncode(entries[index]) + "=" + urlEncode(entries[index + 1]));
    }
    return String.join("&", parts);
  }

  String urlEncode(String raw) {
    return URLEncoder.encode(raw, StandardCharsets.UTF_8);
  }

  String json(String raw) {
    return raw
        .replace("\\", "\\\\")
        .replace("\"", "\\\"");
  }
}
