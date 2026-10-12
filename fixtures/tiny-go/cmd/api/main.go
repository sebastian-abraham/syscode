// Command api serves the storefront HTTP API.
package main

import (
	"log"
	"net/http"

	"shopkit-go/internal/notifications"
	"shopkit-go/internal/orders"
	"shopkit-go/internal/payments"
	"shopkit-go/internal/store"
)

func main() {
	pool := store.Open()
	queue := notifications.NewQueue()
	gateway := payments.NewGateway()
	service := orders.NewService(pool, gateway, queue)

	mux := http.NewServeMux()
	mux.HandleFunc("/orders", service.Create)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	})

	log.Println("listening on :8080")
	log.Fatal(http.ListenAndServe(":8080", mux))
}
