FROM maven:3.9.9-eclipse-temurin-21 AS build
WORKDIR /app

COPY pom.xml ./
COPY src ./src

RUN mvn -q -DskipTests package

FROM eclipse-temurin:21-jre
WORKDIR /app

ENV SERVER_PORT=7500

COPY --from=build /app/target/mock-user-service-*.jar /app/mock-user-service.jar

EXPOSE 7500

CMD ["java", "-jar", "/app/mock-user-service.jar"]
