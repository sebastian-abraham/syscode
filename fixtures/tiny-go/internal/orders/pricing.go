package orders

import (
	"shopkit-go/internal/store"
)

// Pricing is deliberately dull: the money maths lives here and nowhere else.
type Pricing struct {
	TaxRate float64
}

func priceLines(lines []string) int64 {
	var total int64
	for _, line := range lines {
		total += store.UnitPrice(line)
	}
	return total
}

// Record writes the order and its lines in one transaction.
func Record(pool *store.Pool, userID string, lines []string, total int64) (*store.Order, error) {
	return pool.InsertOrder(userID, "pending", lines, total)
}
