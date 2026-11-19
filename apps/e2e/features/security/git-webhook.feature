@security @git
Feature: The Git webhook intake and internal provider routes
  Git platforms call POST /git/webhooks/{endpointKey} without any Paca
  credentials; the provider plugin verifies the delivery's signature. Anything
  that does not name a real endpoint is turned away before the body is read. A
  provider's internal operations are never reachable from a browser.

  Scenario: Unknown endpoint keys are a 404 for every payload
    When a delivery is posted to a key that does not exist
    Then the answer is 404 GIT_NOT_FOUND, whatever the body, headers or event name

  Scenario Outline: Only POST is accepted
    When a client sends <method> to a webhook url
    Then the answer is 405
    Examples:
      | method |
      | GET    |
      | PUT    |
      | DELETE |

  Scenario: A forged signature on a made-up key is not a 401 and not a 500
    When a delivery with X-Hub-Signature-256 is posted to an unknown key
    Then the answer is 404

  Scenario: Odd keys do not crash the intake
    When the endpoint key is very long, URL-encoded, or full of punctuation
    Then the answer is a 4xx

  Scenario: A browser cannot call a provider's internal operations
    When a signed-in user calls /plugins/{id}/_git/{op}
    Then the answer is never 200

  Scenario: The webhook route is reachable without a session but other Git routes are not
    Then the webhook answers 404 and /git/identities answers 401
