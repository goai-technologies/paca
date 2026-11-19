@auth
Feature: Passkeys as a second sign-in factor
  Besides an authenticator app, an account can register passkeys (a device's
  fingerprint, face or screen lock, or a security key). With one registered,
  the password alone only yields a challenge; approving the passkey prompt
  turns it into a session. Removing a passkey needs approval from one of the account's passkeys.

  Rule: Registering and signing in

    Scenario: A user registers a passkey and signs in with it
      Given a signed-in user on the security page
      When they add a passkey named "Work laptop" and approve the browser prompt
      Then "Work laptop" is listed as never used
      When they sign out and sign in with the password
      Then the sign-in page offers "Use a passkey" and no code is needed
      And approving the prompt opens the app
      And the passkey now shows a last-used date

    Scenario: A passkey-only account is challenged for a passkey, not a code
      Given a user whose only second factor is a passkey
      When they sign in with only the password
      Then no session is started and the challenge names "passkey" as the only method
      And the code form is not shown on the sign-in page

    Scenario: An authenticator that lost its credential cannot finish sign-in
      Given a user with a passkey whose authenticator no longer holds it
      When they use a passkey on the challenge page
      Then they are told the prompt was cancelled or timed out
      And they stay on the challenge page and can go back to sign in

  Rule: Removing a passkey

    Scenario: Removal is confirmed with a passkey, not the password
      Given a user with a registered passkey
      When they choose to remove it
      Then the dialog asks for no password
      And without an authenticator able to approve it, the removal fails and the passkey stays

    Scenario: A passkey the device holds can approve its own removal
      Given a user with a registered passkey on this device
      When they remove it and approve the browser prompt
      Then it is gone and sign-in is password-only again

  Rule: When policy requires two-step verification

    Scenario: A protected user sets up a passkey on the sign-in page instead of an app
      Given a policy that requires two-step verification for the user's role
      When they sign in with the password
      Then a passkey is recommended and preselected, and an authenticator app is the alternative
      When they continue and approve the browser prompt
      Then continuing to sign in asks for the passkey and opens the app
