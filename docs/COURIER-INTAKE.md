# Courier Intake System

JT Pets courier service intake page and API for B2B delivery quote requests.

## Overview

A self-contained web page at `/delivery` allows businesses to request delivery quotes. The system:
1. Collects business contact information
2. Geocodes pickup and delivery addresses using Open-Meteo API
3. Calculates distance from JT Pets using haversine formula
4. Shows instant pricing based on distance tiers
5. Submits quote requests to Slack for human follow-up

## Pricing Tiers

| Distance from JT Pets | Price |
|----------------------|-------|
| Within 10km | $10 |
| 10-20km | $15 |
| Over 20km | Contact us for pricing |

Distance is calculated as the greater of: pickup address distance or delivery address distance from JT Pets (43.2557, -79.8711).

## Page: /delivery

**URL:** `https://jtpets.ca/delivery` (or `http://localhost:3001/delivery` locally)

**File:** `public/delivery.html`

### Features

- Mobile-responsive design with JT Pets branding
- Real-time address geocoding with visual feedback
- Instant quote calculation as addresses are entered
- Form validation before submission
- Success/error feedback

### Form Fields

| Field | Required | Description |
|-------|----------|-------------|
| Business Name | Yes | Company name |
| Contact Name | Yes | Primary contact person |
| Phone | Yes | Contact phone number |
| Email | Yes | Contact email address |
| Pickup Address | Yes | Where to pick up the delivery |
| Delivery Address | Yes | Final destination |

## API: POST /api/delivery-quote

**Endpoint:** `/api/delivery-quote`

**Content-Type:** `application/json`

### Request Body

```json
{
  "businessName": "Pet Store Downtown",
  "contactName": "Jane Smith",
  "phone": "(905) 555-1234",
  "email": "jane@petstore.ca",
  "pickupAddress": "123 Main St, Hamilton, ON",
  "deliveryAddress": "456 King St, Burlington, ON",
  "pickupCoords": { "lat": 43.2501, "lng": -79.8496 },
  "deliveryCoords": { "lat": 43.3255, "lng": -79.7990 },
  "quote": {
    "distance": 8.5,
    "price": 10,
    "contactRequired": false
  }
}
```

### Response

**Success (200):**
```json
{
  "success": true,
  "quoteId": "uuid-here",
  "message": "Quote request received. We will follow up shortly."
}
```

**Error (400):**
```json
{
  "error": "All fields are required",
  "code": "MISSING_FIELDS"
}
```

### Error Codes

| Code | Description |
|------|-------------|
| MISSING_FIELDS | Required fields not provided |
| INVALID_EMAIL | Email format validation failed |
| INVALID_QUOTE | Quote data missing or malformed |
| INTERNAL_ERROR | Server-side error |

## Data Storage

Quote requests are saved to `data/delivery-quotes.json` for tracking:

```json
[
  {
    "id": "uuid",
    "timestamp": "2026-03-27T12:00:00.000Z",
    "businessName": "Pet Store Downtown",
    "contactName": "Jane Smith",
    "phone": "(905) 555-1234",
    "email": "jane@petstore.ca",
    "pickupAddress": "123 Main St, Hamilton, ON",
    "deliveryAddress": "456 King St, Burlington, ON",
    "pickupCoords": { "lat": 43.2501, "lng": -79.8496 },
    "deliveryCoords": { "lat": 43.3255, "lng": -79.7990 },
    "quote": {
      "distance": 8.5,
      "price": 10,
      "contactRequired": false
    },
    "status": "pending"
  }
]
```

## Slack Integration

Every quote request posts to `#store-inbox` with:
- Business name and contact info
- Pickup and delivery addresses
- Calculated distance and quote price

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| STORE_INBOX_CHANNEL_ID | Slack channel for notifications | C0APPBSAP4H |
| DELIVERY_QUOTES_FILE | Path to quotes JSON file | data/delivery-quotes.json |

## Technical Details

### Geocoding

Uses the free Open-Meteo Geocoding API:
```
https://geocoding-api.open-meteo.com/v1/search?name={address}&count=1
```

- No API key required
- Results cached client-side to reduce API calls
- 500ms debounce on address input

### Haversine Distance Formula

Standard great-circle distance calculation:
- Earth radius: 6371 km
- Returns distance in kilometers

### JT Pets Location

- Latitude: 43.2557
- Longitude: -79.8711
- Address: Hamilton, Ontario
