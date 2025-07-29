import { readFileSync, writeFileSync } from 'fs';

const filePath = 'src/common/progress-manager.ts';

console.log('🎯 FIXING TO 1 EMAIL PER ERROR - Removing duplicate from progress-manager.ts\n');

try {
  let content = readFileSync(filePath, 'utf8');
  const originalLength = content.length;
  
  // Remove the email notification block from handleJobError method
  content = content.replace(
    /\s*\/\/ Send email notification for job error before cleanup\s*try\s*{\s*await emailNotifier\.notifyJobError\([^}]*?\)\s*;\s*}\s*catch[^}]*?\}\s*/s,
    ''
  );
  
  // Also remove the emailNotifier import if it's no longer used elsewhere
  if (!content.includes('emailNotifier.')) {
    content = content.replace(/import { emailNotifier } from [^;]+;\n/, '');
  }
  
  // Clean up empty lines
  content = content.replace(/\n\n\n+/g, '\n\n');
  
  writeFileSync(filePath, content);
  
  console.log(`✅ Fixed: ${filePath}`);
  console.log(`   Removed: ${originalLength - content.length} characters`);
  console.log(`   Progress manager now only handles cleanup - no duplicate emails`);
  
} catch (error) {
  console.log(`❌ Error: ${error.message}`);
}

console.log('\n🎯 EMAIL FLOW NOW:');
console.log('   1 ERROR → main.ts sends 1 EMAIL → progress-manager.ts does cleanup (no email)');
console.log('\n✅ Result: 1 ERROR = 1 EMAIL ONLY! 🎉');
