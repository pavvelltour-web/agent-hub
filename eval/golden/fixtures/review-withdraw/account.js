export class Account {
  constructor(balance = 0) { this.balance = balance; }
  deposit(amount) {
    if (!(amount > 0)) throw new RangeError('amount must be positive');
    this.balance += amount;
  }
  withdraw(amount) {
    if (!(amount > 0)) throw new RangeError('amount must be positive');
    this.balance -= amount;
  }
}
