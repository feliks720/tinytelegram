FROM golang:latest
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -o gateway .
EXPOSE 8081 8082
CMD ["./gateway"]
