/** The time a use case reads, so a test can set it. Email and LinkedIn both take one. */
export interface Clock {
  now(): Date;
}
