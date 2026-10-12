// Package notifications queues outbound mail behind Redis.
package notifications

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

type Queue struct {
	client *redis.Client
}

func NewQueue() *Queue {
	return &Queue{client: redis.NewClient(&redis.Options{Addr: "localhost:6379"})}
}

// Enqueue pushes a job the worker will pick up.
func (q *Queue) Enqueue(kind string, payload map[string]string) error {
	body, err := json.Marshal(map[string]any{"kind": kind, "payload": payload})
	if err != nil {
		return err
	}
	return q.client.LPush(context.Background(), "jobs", body).Err()
}

// Worker drains the queue and sends mail.
type Worker struct {
	queue *Queue
}

func (w *Worker) Run() {
	for {
		_, err := w.queue.client.BRPop(context.Background(), 0, "jobs").Result()
		if err != nil {
			continue
		}
		sendMail()
	}
}

func sendMail() {}
