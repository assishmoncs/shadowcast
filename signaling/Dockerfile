FROM golang:1.27.4-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -mod=readonly -trimpath -ldflags="-s -w" -o /out/shadowcast-signaling .

FROM scratch
COPY --from=build /out/shadowcast-signaling /shadowcast-signaling
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/shadowcast-signaling"]
