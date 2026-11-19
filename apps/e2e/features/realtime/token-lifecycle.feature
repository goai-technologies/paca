@realtime @token-lifecycle
Feature: A socket never outlives its access token
  A socket is authenticated once, when it connects. About a minute before the
  token expires the server sends "reauth" (the client refreshes its session and
  reconnects on the new cookie); at expiry it disconnects the socket. The
  client reconnects after a server-initiated disconnect, so even one that
  ignores "reauth" ends up with a fresh handshake.

  The stack's access tokens live for 15 minutes, so the specs mint copies of a
  member's real token with a lifetime of seconds, signed with the stack's JWT
  secret, and watch what the server does with them.

  Scenario: A token with plenty of life gets no reauth and stays connected
    Then no reauth arrives over several expiry scans and the socket stays up

  Scenario: Reauth about a minute before expiry, disconnect at expiry
    Given one socket on a token that expires in 75 seconds and one on a token that expires in 30
    Then both receive events while valid
    And the 30 second token is asked to reauthenticate at once, exactly once
    And it is disconnected when it expires with the reason "io server disconnect"
    And the 75 second socket is untouched meanwhile and still receives events
    And it is asked to reauthenticate about a minute early
    And a socket reconnected on a fresh token keeps working
    And the 75 second socket is disconnected at its expiry
    And the fresh socket outlives the old expiry and receives events
    And the expired token cannot connect again
