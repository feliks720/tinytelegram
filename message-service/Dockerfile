FROM golang:1.21-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -o message-service .

FROM alpine:latest
WORKDIR /app
COPY --from=builder /app/message-service .
EXPOSE 9090
CMD ["./message-service"]
