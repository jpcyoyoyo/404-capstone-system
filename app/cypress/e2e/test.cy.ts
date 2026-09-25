describe('Sign-in page', () => {
  it('offers live and demo modes', () => {
    cy.visit('/login');
    cy.contains('SmartGreenhouse');
    cy.contains('Demo').click();
    cy.get('#login-email').type('demo@example.com');
    cy.get('#login-password').type('demo');
    cy.contains('Open demo').click();
    cy.contains('DEMO MODE');
  });
});
