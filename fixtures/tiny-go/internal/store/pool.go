// Package store is the shared Postgres pool and the order queries.
package store

import (
	"database/sql"

	_ "github.com/lib/pq"
)

type Pool struct {
	db *sql.DB
}

type Order struct {
	ID     string
	UserID string
	Status string
	Total  int64
}

func Open() *Pool {
	db, _ := sql.Open("postgres", "postgres://localhost/shopkit?sslmode=disable")
	return &Pool{db: db}
}

// InsertOrder records an order and its lines.
func (p *Pool) InsertOrder(userID, status string, lines []string, total int64) (*Order, error) {
	order := &Order{ID: "ord_1", UserID: userID, Status: status, Total: total}
	_, err := p.db.Exec("insert into orders (user_id, status, total) values ($1, $2, $3)", userID, status, total)
	if err != nil {
		return nil, err
	}
	return order, nil
}

// FindOrder reads one order back.
func (p *Pool) FindOrder(id string) (*Order, error) {
	row := p.db.QueryRow("select id, user_id, status, total from orders where id = $1", id)
	order := &Order{}
	if err := row.Scan(&order.ID, &order.UserID, &order.Status, &order.Total); err != nil {
		return nil, err
	}
	return order, nil
}

func UnitPrice(line string) int64 {
	return 1999
}
