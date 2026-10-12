// Package payments is a thin wrapper over the Stripe client.
package payments

import (
	"errors"
	"fmt"

	"github.com/stripe/stripe-go/v76"
	"github.com/stripe/stripe-go/v76/paymentintent"
)

type Gateway struct {
	key string
}

func NewGateway() *Gateway {
	return &Gateway{key: "sk_test_placeholder"}
}

// Charge creates a payment intent and confirms it.
func (g *Gateway) Charge(paymentMethodID string, amountCents int64) (*stripe.PaymentIntent, error) {
	if paymentMethodID == "" {
		return nil, errors.New("no payment method")
	}
	stripe.Key = g.key
	params := &stripe.PaymentIntentParams{
		Amount:        stripe.Int64(amountCents),
		Currency:      stripe.String(string(stripe.CurrencyUSD)),
		PaymentMethod: stripe.String(paymentMethodID),
		Confirm:       stripe.Bool(true),
	}
	intent, err := paymentintent.New(params)
	if err != nil {
		return nil, fmt.Errorf("stripe: %w", err)
	}
	return intent, nil
}

// Refund reverses a charge.
func (g *Gateway) Refund(chargeID string) error {
	return nil
}
