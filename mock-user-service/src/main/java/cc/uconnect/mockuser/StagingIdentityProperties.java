package cc.uconnect.mockuser;

import java.net.URI;
import org.springframework.core.env.Environment;

final class StagingIdentityProperties {
  private final Environment environment;

  StagingIdentityProperties(Environment environment) {
    this.environment = environment;
  }

  boolean provisionEnabled() {
    return environment.getProperty("staging.identity.provision-enabled", Boolean.class, false);
  }

  String defaultPassword() {
    return required("staging.identity.default-password");
  }

  boolean verifyCreatedUsers() {
    return environment.getProperty("staging.identity.verify-created-users", Boolean.class, false);
  }

  int provisionConcurrency() {
    return environment.getProperty("mock.users.provision-concurrency", Integer.class, 16);
  }

  int provisionBatchSize() {
    return environment.getProperty("mock.users.provision-batch-size", Integer.class, 40);
  }

  String usernamePrefix() {
    return environment.getProperty("staging.identity.username-prefix", "mock.staging");
  }

  String usernameSearchPrefix() {
    return usernamePrefix() + ".";
  }

  String adminClientId() {
    return required("staging.identity.admin-client-id");
  }

  String adminUsername() {
    return required("staging.identity.admin-username");
  }

  String adminPassword() {
    return required("staging.identity.admin-password");
  }

  String clientId() {
    return required("staging.identity.client-id");
  }

  String clientSecret() {
    return required("staging.identity.client-secret");
  }

  String hostHeader() {
    return environment.getProperty("staging.identity.host-header");
  }

  String buildUsername(int index) {
    return usernamePrefix() + "." + String.format("%03d", index);
  }

  String buildDisplayName(int index) {
    return "Mock User " + index;
  }

  int parseUsernameIndex(String username) {
    String prefix = usernameSearchPrefix();
    if (!username.startsWith(prefix)) {
      return -1;
    }

    String suffix = username.substring(prefix.length());
    try {
      return Integer.parseInt(suffix);
    } catch (NumberFormatException exception) {
      return -1;
    }
  }

  URI adminTokenEndpoint() {
    return URI.create(identityTransportBaseUrl() + "/realms/master/protocol/openid-connect/token");
  }

  URI realmTokenEndpoint() {
    return URI.create(identityTransportBaseUrl() + "/realms/" + realm() + "/protocol/openid-connect/token");
  }

  URI adminUsersEndpoint() {
    return URI.create(identityTransportBaseUrl() + "/admin/realms/" + realm() + "/users");
  }

  URI adminUserResetPasswordEndpoint(String userId) {
    return URI.create(adminUsersEndpoint().toString() + "/" + userId + "/reset-password");
  }

  URI targetUsersMeEndpoint() {
    return URI.create(required("staging.identity.target-base-url") + "/api/users/me");
  }

  private String identityTransportBaseUrl() {
    return environment.getProperty(
        "staging.identity.transport-url",
        required("staging.identity.base-url")
    );
  }

  private String realm() {
    return required("staging.identity.realm");
  }

  private String required(String key) {
    String value = environment.getProperty(key);
    if (value == null || value.isBlank()) {
      throw new IllegalStateException("Missing required property " + key);
    }
    return value;
  }
}
