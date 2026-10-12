// Package orders owns the order lifecycle: validation, pricing, persistence.
package orders

import (
	"encoding/json"
	"net/http"

	"shopkit-go/internal/notifications"
	"shopkit-go/internal/payments"
	"shopkit-go/internal/store"
)

// Service is the order lifecycle.
type Service struct {
	pool    *store.Pool
	gateway *payments.Gateway
	queue   *notifications.Queue
}

func NewService(pool *store.Pool, gateway *payments.Gateway, queue *notifications.Queue) *Service {
	return &Service{pool: pool, gateway: gateway, queue: queue}
}

// Create validates the cart, charges it and records the order.
func (s *Service) Create(w http.ResponseWriter, r *http.Request) {
	var input struct {
		UserID          string   `json:"userId"`
		PaymentMethodID string   `json:"paymentMethodId"`
		Lines           []string `json:"lines"`
	}
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	total := priceLines(input.Lines)
	charge, err := s.gateway.Charge(input.PaymentMethodID, total)
	if err != nil {
		http.Error(w, err.Error(), http.StatusPaymentRequired)
		return
	}

	order, err := s.pool.InsertOrder(input.UserID, "paid", input.Lines, total)
	if err != nil {
		http.Error(w, "could not record the order", http.StatusInternalServerError)
		return
	}

	s.queue.Enqueue("order.created", map[string]string{
		"orderId": order.ID,
		"chargeId": charge.ID,
	})

	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(order)
}
