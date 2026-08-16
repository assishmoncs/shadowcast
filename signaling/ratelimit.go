package main

import (
	"sync"
	"time"
)

type RateLimiter struct {
	rate       float64
	capacity   float64
	tokens     float64
	lastRefill time.Time
	mu         sync.Mutex
}

func NewRateLimiter(ratePerSec int) *RateLimiter {
	return &RateLimiter{
		rate:       float64(ratePerSec),
		capacity:   float64(ratePerSec * 2), // Allow short bursts
		tokens:     float64(ratePerSec),
		lastRefill: time.Now(),
	}
}

func (rl *RateLimiter) Allow() bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()
	elapsed := now.Sub(rl.lastRefill).Seconds()
	rl.lastRefill = now

	rl.tokens += elapsed * rl.rate
	if rl.tokens > rl.capacity {
		rl.tokens = rl.capacity
	}

	if rl.tokens >= 1.0 {
		rl.tokens -= 1.0
		return true
	}

	return false
}
