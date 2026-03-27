FROM golang:latest
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -o message-service .
EXPOSE 9090
CMD ["./message-service"]
