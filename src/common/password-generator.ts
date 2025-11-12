/**
 * Generates a random password that meets Booking.com requirements:
 * - Minimum 10 characters
 * - At least one uppercase letter
 * - At least one lowercase letter
 * - At least one number
 */
export function generateRandomPassword(length: number = 12): string {
  const uppercase = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const lowercase = "abcdefghijklmnopqrstuvwxyz";
  const numbers = "0123456789";
  const allChars = uppercase + lowercase + numbers;

  // Ensure minimum length of 10
  const actualLength = Math.max(length, 10);

  let password = "";

  // Ensure at least one character from each required category
  password += uppercase[Math.floor(Math.random() * uppercase.length)];
  password += lowercase[Math.floor(Math.random() * lowercase.length)];
  password += numbers[Math.floor(Math.random() * numbers.length)];

  // Fill the rest with random characters
  for (let i = password.length; i < actualLength; i++) {
    password += allChars[Math.floor(Math.random() * allChars.length)];
  }

  // Shuffle the password to avoid predictable pattern
  return password
    .split("")
    .sort(() => Math.random() - 0.5)
    .join("");
}
