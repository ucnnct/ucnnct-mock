FROM node:22-bookworm AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY angular.json ./
COPY tsconfig*.json ./
COPY public ./public
COPY src ./src

RUN npm run build

FROM nginx:1.29-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/mock-control-center/browser /usr/share/nginx/html

EXPOSE 80
