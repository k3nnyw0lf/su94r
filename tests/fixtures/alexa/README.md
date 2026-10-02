# Test certificates (throwaway)

A chain made with openssl only for tests/alexa-verify.test.js: Test Root CA, Test
Intermediate and a leaf named echo-api.amazon.com. leaf.key signs test request bodies.
None of it is trusted by anything outside these tests, and none of it is a real secret.
